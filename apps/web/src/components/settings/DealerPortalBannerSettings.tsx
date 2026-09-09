import { usePeopleCopy } from "@/hooks/usePeopleCopy";
import { useEffect, useState, useRef } from "react";
import { ImageIcon, Loader2, Save, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

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
  const pc = usePeopleCopy();
  const latestCopy = useRef(pc);
  latestCopy.current = pc;
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
        toast.error(latestCopy.current("unableToLoadDealerOrderBanners"));
      } finally {
        setLoading(false);
      }
    };

    void fetchBannerSettings();
    // Fetch once on mount; language changes must not overwrite unsaved banner edits.
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
      toast.error(pc("bannersMustBeJpgPngOrWebp"));
      return;
    }

    if (file.size > MAX_BANNER_SIZE) {
      toast.error(pc("bannersMustBeAtMost5mb"));
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
      toast.info(pc("chooseABannerImageBeforeSavingThis"));
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
        if (!publicUrl) throw new Error(pc("unableToCreateAPublicUrlFor"));

        nextBanner = { ...nextBanner, url: publicUrl, path: filePath, enabled: true };
      }

      const nextBanners = banners.map((banner, index) => (index === slot ? nextBanner : banner));
      await persistBanners(nextBanners);
      setBanners(nextBanners);
      setBannerFiles((current) => ({ ...current, [slot]: null }));
      toast.success(pc("bannerUpdated", { p0: slot + 1 }));
    } catch (error) {
      console.error("Failed to save dealer portal banner", error);
      toast.error(pc("unableToSaveTheDealerOrderBanner"), {
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
      toast.success(pc("eventBannerListSaved"));
    } catch (error) {
      console.error("Failed to save dealer portal banner list", error);
      toast.error(pc("unableToSaveTheBannerList"), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSavingSlot(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ImageIcon className="h-5 w-5 text-primary" /> {pc("dealerOrderLandingBanners")} </CardTitle>
        <CardDescription> {pc("manageUpToThreePromotionEventBanners")} </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {pc("loadingBannerSettings")} </div>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-3">
              {banners.map((banner, index) => {
                const previewUrl = previewUrls[index] || banner.url;
                const saving = savingSlot === index;

                return (
                  <div key={banner.id} className="space-y-3 rounded-lg border bg-card p-3">
                    <div className="overflow-hidden rounded-lg border bg-muted/40">
                      {previewUrl ? (
                        <img src={previewUrl} alt={pc("dealerOrderLandingBanner", { p0: index + 1 })} className="aspect-[16/10] w-full object-cover" />
                      ) : (
                        <div className="flex aspect-[16/10] flex-col items-center justify-center gap-2 text-muted-foreground">
                          <ImageIcon className="h-8 w-8" />
                          <span className="text-sm">{pc("noBannerYet")}</span>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`dealer-banner-label-${index}`}>{pc("eventBannerName")} {index + 1}</Label>
                      <Input
                        id={`dealer-banner-label-${index}`}
                        value={banner.eventLabel}
                        maxLength={60}
                        onChange={(event) => updateBanner(index, { eventLabel: event.target.value })}
                        placeholder={pc("event", { p0: index + 1 })}
                      />
                    </div>

                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="flex items-center justify-between rounded-md border bg-muted/30 p-3 text-sm">
                        <span className="text-muted-foreground">{pc("showThisBanner")}</span>
                        <input
                          type="checkbox"
                          checked={banner.enabled}
                          disabled={!banner.url && !bannerFiles[index]}
                          onChange={(event) => updateBanner(index, { enabled: event.target.checked })}
                          className="h-4 w-4 accent-primary"
                          aria-label={pc("enableBanner", { p0: index + 1 })}
                        />
                      </div>
                      <div className="flex items-center justify-between rounded-md border bg-muted/30 p-3 text-sm">
                        <span className="text-muted-foreground">{pc("publishContent")}</span>
                        <input
                          type="checkbox"
                          checked={banner.published}
                          onChange={(event) => updateBanner(index, { published: event.target.checked })}
                          className="h-4 w-4 accent-primary"
                          aria-label={pc("publishContentForBanner", { p0: index + 1 })}
                        />
                      </div>
                    </div>

                    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                      <div className="space-y-2">
                        <Label htmlFor={`dealer-banner-content-title-${index}`}>{pc("contentPageTitle")}</Label>
                        <Input
                          id={`dealer-banner-content-title-${index}`}
                          value={banner.contentTitle}
                          maxLength={90}
                          onChange={(event) => updateBanner(index, { contentTitle: event.target.value })}
                          placeholder={pc("eGOpeningOfferForDealers")}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`dealer-banner-content-intro-${index}`}>{pc("shortDescription")}</Label>
                        <textarea
                          id={`dealer-banner-content-intro-${index}`}
                          value={banner.contentIntro}
                          maxLength={260}
                          onChange={(event) => updateBanner(index, { contentIntro: event.target.value })}
                          placeholder={pc("summarizeTheProgramInOneOrTwo")}
                          className="min-h-[76px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`dealer-banner-highlights-${index}`}>{pc("highlightsOnePerLine")}</Label>
                        <textarea
                          id={`dealer-banner-highlights-${index}`}
                          value={banner.contentHighlights.join("\n")}
                          onChange={(event) => updateBanner(index, { contentHighlights: event.target.value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6) })}
                          placeholder={pc("wholesalePricingByDealerProfileProgramApplies")}
                          className="min-h-[104px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`dealer-banner-terms-${index}`}>{pc("termsAndConditions")}</Label>
                        <textarea
                          id={`dealer-banner-terms-${index}`}
                          value={banner.contentTerms}
                          maxLength={360}
                          onChange={(event) => updateBanner(index, { contentTerms: event.target.value })}
                          placeholder={pc("subjectToRegionDealerProfileAndBmq")}
                          className="min-h-[76px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`dealer-banner-note-${index}`}>{pc("notes")}</Label>
                        <Input
                          id={`dealer-banner-note-${index}`}
                          value={banner.contentNote}
                          maxLength={160}
                          onChange={(event) => updateBanner(index, { contentNote: event.target.value })}
                          placeholder={pc("eGContactCustomerServiceBmqZalo")}
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`dealer-landing-banner-${index}`}>{pc("bannerImage")}</Label>
                      <Input
                        id={`dealer-landing-banner-${index}`}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={(event) => handlePickFile(index, event.target.files?.[0] || null)}
                      />
                      <p className="text-xs leading-5 text-muted-foreground">{pc("recommended16001000Or1610Jpg")}</p>
                    </div>

                    {banner.path ? (
                      <div className="break-all rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground"> {pc("path")} <span className="font-mono">{banner.path}</span>
                      </div>
                    ) : null}

                    <Button className="w-full" onClick={() => saveBannerSlot(index)} disabled={savingSlot !== null || (!bannerFiles[index] && !banner.url)}>
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : bannerFiles[index] ? <Save className="h-4 w-4" /> : <UploadCloud className="h-4 w-4" />} {pc("saveBanner")} {index + 1}
                    </Button>
                  </div>
                );
              })}
            </div>

            <Button variant="outline" className="w-full md:w-auto" onClick={saveBannerList} disabled={savingSlot !== null}>
              {savingSlot === -1 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {pc("saveOrderStatusOfAllThreeBanners")} </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
