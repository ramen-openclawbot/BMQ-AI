import { Info } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { useAppVersion } from "@/hooks/useAppVersion";
import { Skeleton } from "@/components/ui/skeleton";

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
  const { version, isLoading } = useAppVersion();
  const buildTime = formatBuildTime(__APP_VERSION__);

  return (
    <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Info className="h-5 w-5 text-primary" />
        <h2 className="font-display font-semibold text-lg">Thông tin ứng dụng</h2>
      </div>
      <Separator />
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">Phiên bản</p>
          <p className="text-sm text-muted-foreground">
            Phiên bản hiện tại của ứng dụng
          </p>
        </div>
        {isLoading ? (
          <Skeleton className="h-6 w-24" />
        ) : (
          <span className="text-sm font-mono bg-muted px-3 py-1.5 rounded-md">
            {version || "v1.0.0"}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">Build time</p>
          <p className="text-sm text-muted-foreground">
            Thời điểm build ứng dụng
          </p>
        </div>
        <span className="text-sm font-mono bg-muted px-3 py-1.5 rounded-md">
          {buildTime}
        </span>
      </div>
    </div>
  );
}
