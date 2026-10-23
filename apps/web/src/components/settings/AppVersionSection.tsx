import { RefreshCw } from "lucide-react";
import { useAppVersion } from "@/hooks/useAppVersion";
import { SettingsGroup, SettingsRow } from "./SettingsKit";
import { useLanguage } from "@/contexts/LanguageContext";

// Declare the global build version injected by Vite
declare const __APP_VERSION__: string;

function formatBuildTime(timestamp: string): string {
  try {
    const date = new Date(parseInt(timestamp));
    if (isNaN(date.getTime())) return "N/A";
    return date.toLocaleString("vi-VN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "N/A";
  }
}

export function AppVersionSection() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const { version, isLoading } = useAppVersion();
  const buildTime = formatBuildTime(__APP_VERSION__);

  return (
    <SettingsGroup id="app-info" title={isVi ? "Ứng dụng" : "Application"}>
      <SettingsRow label={isVi ? "Phiên bản" : "Version"} value={isLoading ? "…" : <b>{version || "v0.0.0"}</b>} />
      <SettingsRow label={isVi ? "Bản dựng lúc" : "Build time"} value={buildTime} />
      <SettingsRow
        label={isVi ? "Tải lại trang" : "Reload page"}
        hint={isVi ? "Khi giao diện hiển thị sai" : "If the page looks wrong"}
        action={<button type="button" className="st-link" onClick={() => window.location.reload()}><RefreshCw />{isVi ? "Tải lại" : "Reload"}</button>}
      />
    </SettingsGroup>
  );
}
