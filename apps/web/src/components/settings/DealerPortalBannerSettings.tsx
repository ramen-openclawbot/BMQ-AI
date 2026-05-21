import { useEffect, useState } from "react";
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
const MAX_BANNER_SIZE = 5 * 1024 * 1024;
const ALLOWED_BANNER_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function DealerPortalBannerSettings() {
  const [bannerUrl, setBannerUrl] = useState("");
  const [bannerPath, setBannerPath] = useState("");
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const fetchBannerSettings = async () => {
      try {
        const { data, error } = await supabase
          .from("app_settings")
          .select("key, value")
          .in("key", [BANNER_URL_KEY, BANNER_PATH_KEY]);

        if (error) throw error;

        const urlSetting = data?.find((row) => row.key === BANNER_URL_KEY);
        const pathSetting = data?.find((row) => row.key === BANNER_PATH_KEY);
        setBannerUrl(String(urlSetting?.value || ""));
        setBannerPath(String(pathSetting?.value || ""));
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
    if (!bannerFile) {
      setPreviewUrl("");
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(bannerFile);
    setPreviewUrl(nextPreviewUrl);
    return () => URL.revokeObjectURL(nextPreviewUrl);
  }, [bannerFile]);

  const handlePickFile = (file: File | null) => {
    if (!file) {
      setBannerFile(null);
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

    setBannerFile(file);
  };

  const saveBanner = async () => {
    if (!bannerFile) {
      toast.info("Anh chọn ảnh banner trước khi lưu.");
      return;
    }

    setSaving(true);
    try {
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

      const { error: saveError } = await supabase.from("app_settings").upsert([
        { key: BANNER_URL_KEY, value: publicUrl },
        { key: BANNER_PATH_KEY, value: filePath },
      ]);

      if (saveError) throw saveError;

      setBannerUrl(publicUrl);
      setBannerPath(filePath);
      setBannerFile(null);
      toast.success("Đã cập nhật banner landing page đặt hàng.");
    } catch (error) {
      console.error("Failed to save dealer portal banner", error);
      toast.error("Không lưu được banner đặt hàng đại lý", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ImageIcon className="h-5 w-5 text-primary" />
          Banner landing đặt hàng đại lý
        </CardTitle>
        <CardDescription>
          Upload banner promotion hiển thị ở landing page public của dathang.banhmique.vn trước khi đại lý đăng nhập.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Đang tải cấu hình banner...
          </div>
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border bg-muted/40">
              {previewUrl || bannerUrl ? (
                <img
                  src={previewUrl || bannerUrl}
                  alt="Banner landing đặt hàng đại lý"
                  className="h-48 w-full object-cover md:h-64"
                />
              ) : (
                <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground md:h-64">
                  <ImageIcon className="h-8 w-8" />
                  <span className="text-sm">Chưa có banner upload</span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="dealer-landing-banner">Ảnh banner promotion</Label>
              <Input
                id="dealer-landing-banner"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => handlePickFile(event.target.files?.[0] || null)}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Khuyến nghị ảnh ngang 16:9 hoặc 4:3, JPG/PNG/WebP, tối đa 5MB. Landing page sẽ tự phủ gradient để chữ đọc rõ.
              </p>
            </div>

            {bannerPath ? (
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                Path hiện tại: <span className="font-mono">{bannerPath}</span>
              </div>
            ) : null}

            <Button className="w-full md:w-auto" onClick={saveBanner} disabled={saving || !bannerFile}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : bannerFile ? <Save className="h-4 w-4" /> : <UploadCloud className="h-4 w-4" />}
              Lưu banner landing
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
