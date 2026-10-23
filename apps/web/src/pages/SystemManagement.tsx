import { useLanguage } from "@/contexts/LanguageContext";
import { AppVersionSection } from "@/components/settings/AppVersionSection";
import { GoogleDriveSettings } from "@/components/settings/GoogleDriveSettings";
import { DealerPortalBannerSettings } from "@/components/settings/DealerPortalBannerSettings";
import { SettingsPage } from "@/components/settings/SettingsKit";

/** Owner-only system settings as grouped lists (owner 23/10/2026). */
export default function SystemManagement() {
  const { t } = useLanguage();

  return (
    <SettingsPage title={t.systemManagement}>
      <GoogleDriveSettings />
      <DealerPortalBannerSettings />
      <AppVersionSection />
    </SettingsPage>
  );
}
