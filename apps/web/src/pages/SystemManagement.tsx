import { useLanguage } from "@/contexts/LanguageContext";
import { AppVersionSection } from "@/components/settings/AppVersionSection";
import { GoogleDriveSettings } from "@/components/settings/GoogleDriveSettings";
import { DataMigrationSettings } from "@/components/settings/DataMigrationSettings";

export default function SystemManagement() {
  const { language, t } = useLanguage();
  const isVi = language === "vi";

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">
          {t.systemManagement}
        </h1>
        <p className="text-muted-foreground mt-1">
          {isVi
            ? "Quản lý các tích hợp hệ thống và công cụ migration dành cho owner."
            : "Manage system integrations and migration tools for owners."}
        </p>
      </div>

      <div className="sticky top-2 z-10 rounded-lg border border-border bg-background/95 backdrop-blur p-2">
        <div className="flex gap-2 overflow-x-auto whitespace-nowrap">
          <a href="#google-drive" className="text-xs px-3 py-1.5 rounded-md hover:bg-accent">{isVi ? "Tích hợp Google Drive" : "Google Drive Integration"}</a>
          <a href="#data-migration" className="text-xs px-3 py-1.5 rounded-md hover:bg-accent">{isVi ? "Di chuyển dữ liệu" : "Data Migration"}</a>
          <a href="#app-info" className="text-xs px-3 py-1.5 rounded-md hover:bg-accent">{isVi ? "Thông tin ứng dụng" : "Application Info"}</a>
        </div>
      </div>

      <div id="google-drive" className="scroll-mt-24">
        <GoogleDriveSettings />
      </div>

      <div id="data-migration" className="scroll-mt-24">
        <DataMigrationSettings />
      </div>

      <div id="app-info" className="scroll-mt-24">
        <AppVersionSection />
      </div>
    </div>
  );
}
