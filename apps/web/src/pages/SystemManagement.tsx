import { useLanguage } from "@/contexts/LanguageContext";
import { Separator } from "@/components/ui/separator";
import { Database, FolderCog, Info } from "lucide-react";
import { GoogleDriveSettings } from "@/components/settings/GoogleDriveSettings";
import { DataMigrationSettings } from "@/components/settings/DataMigrationSettings";
import { AppVersionSection } from "@/components/settings/AppVersionSection";

export default function SystemManagement() {
  const { t } = useLanguage();

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">
          {t.systemManagement}
        </h1>
        <p className="text-muted-foreground mt-1">
          Quản lý các tích hợp hệ thống và công cụ migration dành cho owner.
        </p>
      </div>

      <div className="sticky top-2 z-10 rounded-lg border border-border bg-background/95 backdrop-blur p-2">
        <div className="flex gap-2 overflow-x-auto whitespace-nowrap">
          <a href="#google-drive" className="text-xs px-3 py-1.5 rounded-md hover:bg-accent">Google Drive Integration</a>
          <a href="#data-migration" className="text-xs px-3 py-1.5 rounded-md hover:bg-accent">Data Migration</a>
          <a href="#app-info" className="text-xs px-3 py-1.5 rounded-md hover:bg-accent">Thông tin ứng dụng</a>
        </div>
      </div>

      <div id="google-drive" className="scroll-mt-24 space-y-4">
        <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
          <div className="flex items-center gap-3">
            <FolderCog className="h-5 w-5 text-primary" />
            <h2 className="font-display font-semibold text-lg">Google Drive Integration</h2>
          </div>
          <Separator />
          <p className="text-sm text-muted-foreground">
            Cấu hình kết nối Google Drive/Gmail và đồng bộ thư mục nghiệp vụ.
          </p>
        </div>
        <GoogleDriveSettings />
      </div>

      <div id="data-migration" className="scroll-mt-24 space-y-4">
        <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-primary" />
            <h2 className="font-display font-semibold text-lg">Data Migration</h2>
          </div>
          <Separator />
          <p className="text-sm text-muted-foreground">
            Xuất dữ liệu và kiểm tra các thành phần lưu trữ phục vụ migration hệ thống.
          </p>
        </div>
        <DataMigrationSettings />
      </div>

      <div id="app-info" className="scroll-mt-24 space-y-4">
        <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Info className="h-5 w-5 text-primary" />
            <h2 className="font-display font-semibold text-lg">Thông tin ứng dụng</h2>
          </div>
          <Separator />
          <p className="text-sm text-muted-foreground">
            Theo dõi phiên bản hiện tại và thời điểm build của ứng dụng.
          </p>
        </div>
        <AppVersionSection />
      </div>
    </div>
  );
}
