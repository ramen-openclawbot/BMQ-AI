import { useEffect, useState } from "react";
import { Loader2, Save, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsRow, SettingsStatus } from "./SettingsKit";
import { supabase } from "@/integrations/supabase/client";
import { LoadingState } from "@/components/ui/loading";

const DEALER_ASSET_BUCKET = "dealer-portal-assets";
const BANNER_URL_KEY = "dealer_landing_banner_url";
const BANNER_PATH_KEY = "dealer_landing_banner_path";
const BANNERS_KEY = "dealer_landing_banners";
const MAX_BANNER_SIZE = 5 * 1024 * 1024;
const MAX_EVENT_BANNERS = 3;
const ALLOWED_BANNER_TYPES = ["image/jpeg", "image/png", "image/webp"];

type DealerLandingBanner = {
  id: string;
  eventLabel: string;
  url: string;
  path: string;
  enabled: boolean;
  contentTitle: string;
  contentIntro: string;
  contentHighlights: string[];
  contentTerms: string;
  contentNote: string;
  published: boolean;
};

const createEmptyBanner = (index: number): DealerLandingBanner => ({
  id: `event-${index + 1}`,
  eventLabel: `Sự kiện ${index + 1}`,
  url: "",
  path: "",
  enabled: index === 0,
  contentTitle: "",
  contentIntro: "",
  contentHighlights: [],
  contentTerms: "",
  contentNote: "",
  published: index === 0,
});

const normalizeBanners = (raw: unknown, fallbackUrl = "", fallbackPath = "") => {
  let parsed: DealerLandingBanner[] = [];

  if (typeof raw === "string" && raw.trim()) {
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) {
        parsed = value
          .slice(0, MAX_EVENT_BANNERS)
          .map((item, index) => ({
            id: typeof item?.id === "string" && item.id ? item.id : `event-${index + 1}`,
            eventLabel: typeof item?.eventLabel === "string" && item.eventLabel ? item.eventLabel : `Sự kiện ${index + 1}`,
            url: typeof item?.url === "string" ? item.url : "",
            path: typeof item?.path === "string" ? item.path : "",
            enabled: item?.enabled !== false,
            contentTitle: typeof item?.contentTitle === "string" ? item.contentTitle : "",
            contentIntro: typeof item?.contentIntro === "string" ? item.contentIntro : "",
            contentHighlights: Array.isArray(item?.contentHighlights)
              ? item.contentHighlights.filter((line: unknown) => typeof line === "string" && line.trim()).slice(0, 6)
              : [],
            contentTerms: typeof item?.contentTerms === "string" ? item.contentTerms : "",
            contentNote: typeof item?.contentNote === "string" ? item.contentNote : "",
            published: item?.published !== false,
          }));
      }
    } catch {
      parsed = [];
    }
  }

  if (!parsed.length && fallbackUrl) {
    parsed = [{ ...createEmptyBanner(0), eventLabel: "Banner chính", url: fallbackUrl, path: fallbackPath, enabled: true, published: true }];
  }

  while (parsed.length < MAX_EVENT_BANNERS) {
    parsed.push(createEmptyBanner(parsed.length));
  }

  return parsed.slice(0, MAX_EVENT_BANNERS);
};

export function DealerPortalBannerSettings() {
  const [banners, setBanners] = useState<DealerLandingBanner[]>(() => normalizeBanners(null));
  const [bannerFiles, setBannerFiles] = useState<Record<number, File | null>>({});
  const [previewUrls, setPreviewUrls] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [savingSlot, setSavingSlot] = useState<number | null>(null);

  useEffect(() => {
    const fetchBannerSettings = async () => {
      try {
        const { data, error } = await supabase
          .from("app_settings")
          .select("key, value")
          .in("key", [BANNER_URL_KEY, BANNER_PATH_KEY, BANNERS_KEY]);

        if (error) throw error;

        const urlSetting = data?.find((row) => row.key === BANNER_URL_KEY);
        const pathSetting = data?.find((row) => row.key === BANNER_PATH_KEY);
        const bannersSetting = data?.find((row) => row.key === BANNERS_KEY);
        setBanners(normalizeBanners(bannersSetting?.value, String(urlSetting?.value || ""), String(pathSetting?.value || "")));
      } catch (error) {
        console.error("Failed to fetch dealer portal banner settings", error);
        toast.error("Không tải được banner đặt hàng đại lý");
      } finally {
        setLoading(false);
      }
    };

    void fetchBannerSettings();
  }, []);

  useEffect(() => {
    const nextPreviewUrls: Record<number, string> = {};

    Object.entries(bannerFiles).forEach(([slot, file]) => {
      if (file) {
        nextPreviewUrls[Number(slot)] = URL.createObjectURL(file);
      }
    });

    setPreviewUrls(nextPreviewUrls);

    return () => {
      Object.values(nextPreviewUrls).forEach((url) => URL.revokeObjectURL(url));
    };
  }, [bannerFiles]);

  const handlePickFile = (slot: number, file: File | null) => {
    if (!file) {
      setBannerFiles((current) => ({ ...current, [slot]: null }));
      return;
    }

    if (!ALLOWED_BANNER_TYPES.includes(file.type)) {
      toast.error("Banner chỉ nhận JPG, PNG hoặc WebP.");
      return;
    }

    if (file.size > MAX_BANNER_SIZE) {
      toast.error("Banner tối đa 5MB.");
      return;
    }

    setBannerFiles((current) => ({ ...current, [slot]: file }));
  };

  const updateBanner = (slot: number, patch: Partial<DealerLandingBanner>) => {
    setBanners((current) => current.map((banner, index) => (index === slot ? { ...banner, ...patch } : banner)));
  };

  const persistBanners = async (nextBanners: DealerLandingBanner[]) => {
    const enabledBanners = nextBanners.filter((banner) => banner.enabled && banner.url).slice(0, MAX_EVENT_BANNERS);
    const primaryBanner = enabledBanners[0] || nextBanners.find((banner) => banner.url);

    const { error } = await supabase.from("app_settings").upsert([
      { key: BANNERS_KEY, value: JSON.stringify(nextBanners.slice(0, MAX_EVENT_BANNERS)) },
      { key: BANNER_URL_KEY, value: primaryBanner?.url || "" },
      { key: BANNER_PATH_KEY, value: primaryBanner?.path || "" },
    ]);

    if (error) throw error;
  };

  const saveBannerSlot = async (slot: number) => {
    const bannerFile = bannerFiles[slot];
    const currentBanner = banners[slot];

    if (!currentBanner?.url && !bannerFile) {
      toast.info("Anh chọn ảnh banner trước khi lưu slot này.");
      return;
    }

    setSavingSlot(slot);
    try {
      let nextBanner = { ...currentBanner, enabled: currentBanner.enabled || Boolean(bannerFile) };

      if (bannerFile) {
        const extension = bannerFile.name.split(".").pop()?.toLowerCase() || "webp";
        const filePath = `landing/${Date.now()}-${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await supabase.storage
          .from(DEALER_ASSET_BUCKET)
          .upload(filePath, bannerFile, {
            upsert: false,
            contentType: bannerFile.type,
            cacheControl: "3600",
          });

        if (uploadError) throw uploadError;

        const publicUrl = supabase.storage.from(DEALER_ASSET_BUCKET).getPublicUrl(filePath).data?.publicUrl;
        if (!publicUrl) throw new Error("Không tạo được public URL cho banner.");

        nextBanner = { ...nextBanner, url: publicUrl, path: filePath, enabled: true };
      }

      const nextBanners = banners.map((banner, index) => (index === slot ? nextBanner : banner));
      await persistBanners(nextBanners);
      setBanners(nextBanners);
      setBannerFiles((current) => ({ ...current, [slot]: null }));
      toast.success(`Đã cập nhật banner ${slot + 1}.`);
    } catch (error) {
      console.error("Failed to save dealer portal banner", error);
      toast.error("Không lưu được banner đặt hàng đại lý", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingSlot(null);
    }
  };

  const saveBannerList = async () => {
    setSavingSlot(-1);
    try {
      await persistBanners(banners);
      toast.success("Đã lưu danh sách banner sự kiện.");
    } catch (error) {
      console.error("Failed to save dealer portal banner list", error);
      toast.error("Không lưu được danh sách banner", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingSlot(null);
    }
  };

  const listButton = (
    <button type="button" className="st-link" onClick={() => void saveBannerList()} disabled={savingSlot !== null} data-bmq-banner-save-list>
      {savingSlot === -1 ? <Loader2 className="animate-spin" /> : <Save />}Lưu trạng thái 3 banner
    </button>
  );

  return (
    <SettingsGroup id="dealer-portal" title="Banner trang đặt hàng đại lý" footer={loading ? null : listButton}>
      {loading ? (
        <LoadingState flat rows={3} label="Đang tải cấu hình banner…" />
      ) : banners.map((banner, index) => {
        const previewUrl = previewUrls[index] || banner.url;
        const saving = savingSlot === index;
        const state = !previewUrl ? <SettingsStatus tone="off">Trống</SettingsStatus>
          : banner.enabled ? <SettingsStatus tone="ok">Đang hiện</SettingsStatus>
          : <SettingsStatus tone="off">Tắt</SettingsStatus>;
        return (
          <SettingsRow
            key={banner.id}
            dataAttr="bmq-banner-row"
            label={<span className="flex items-center gap-3">
              <span className="st-thumb" aria-hidden="true">{previewUrl ? <img src={previewUrl} alt="" /> : null}</span>
              <span className="min-w-0">{banner.eventLabel || `Banner ${index + 1}`}</span>
            </span>}
            value={state}
          >
            {previewUrl ? <div className="st-preview"><img src={previewUrl} alt={`Banner ${index + 1}`} /></div> : null}
            <label className="st-field">
              <span>Ảnh banner</span>
              <Input id={`dealer-landing-banner-${index}`} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handlePickFile(index, event.target.files?.[0] || null)} />
              <small>16:10, JPG/PNG/WebP, tối đa 5MB</small>
            </label>
            <label className="st-field">
              <span>Tên banner</span>
              <Input id={`dealer-banner-label-${index}`} value={banner.eventLabel} maxLength={60} onChange={(event) => updateBanner(index, { eventLabel: event.target.value })} placeholder={`Sự kiện ${index + 1}`} />
            </label>
            <div className="st-checks">
              <label className="st-check">
                <input type="checkbox" checked={banner.enabled} disabled={!banner.url && !bannerFiles[index]} onChange={(event) => updateBanner(index, { enabled: event.target.checked })} aria-label={`Bật banner ${index + 1}`} />
                Hiện banner
              </label>
              <label className="st-check">
                <input type="checkbox" checked={banner.published} onChange={(event) => updateBanner(index, { published: event.target.checked })} aria-label={`Post nội dung banner ${index + 1}`} />
                Có trang nội dung
              </label>
            </div>
            <label className="st-field">
              <span>Tiêu đề trang nội dung</span>
              <Input id={`dealer-banner-content-title-${index}`} value={banner.contentTitle} maxLength={90} onChange={(event) => updateBanner(index, { contentTitle: event.target.value })} placeholder="VD: Ưu đãi khai trương dành cho đại lý" />
            </label>
            <label className="st-field">
              <span>Mô tả ngắn</span>
              <textarea id={`dealer-banner-content-intro-${index}`} value={banner.contentIntro} maxLength={260} onChange={(event) => updateBanner(index, { contentIntro: event.target.value })} placeholder="Tóm tắt chương trình trong 1-2 câu." />
            </label>
            <label className="st-field">
              <span>Điểm nổi bật · mỗi dòng một ý</span>
              <textarea id={`dealer-banner-highlights-${index}`} value={banner.contentHighlights.join("\n")} onChange={(event) => updateBanner(index, { contentHighlights: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6) })} placeholder={"Giá sỉ theo hồ sơ đại lý\nChương trình áp dụng trong tháng"} />
            </label>
            <label className="st-field">
              <span>Điều kiện áp dụng</span>
              <textarea id={`dealer-banner-terms-${index}`} value={banner.contentTerms} maxLength={360} onChange={(event) => updateBanner(index, { contentTerms: event.target.value })} placeholder="Áp dụng theo khu vực, hồ sơ đại lý và chính sách BMQ." />
            </label>
            <label className="st-field">
              <span>Ghi chú</span>
              <Input id={`dealer-banner-note-${index}`} value={banner.contentNote} maxLength={160} onChange={(event) => updateBanner(index, { contentNote: event.target.value })} placeholder="VD: Cần hỗ trợ liên hệ CSKH / Zalo OA BMQ." />
            </label>
            <div className="st-panel-actions">
              <button type="button" className="st-link is-primary" onClick={() => void saveBannerSlot(index)} disabled={savingSlot !== null || (!bannerFiles[index] && !banner.url)} data-bmq-banner-save>
                {saving ? <Loader2 className="animate-spin" /> : bannerFiles[index] ? <Save /> : <UploadCloud />}Lưu banner
              </button>
            </div>
          </SettingsRow>
        );
      })}
    </SettingsGroup>
  );
}
