import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { clearSessionAndReload } from "@/lib/session-utils";

interface SessionRecoveryOverlayProps {
  onRetry: () => void;
}

export function SessionRecoveryOverlay({ onRetry }: SessionRecoveryOverlayProps) {
  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-background rounded-lg shadow-xl max-w-sm w-full p-6 space-y-4">
        <div className="text-center">
          <AlertTriangle className="h-12 w-12 text-amber-500 dark:text-amber-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-foreground">
            Phiên đăng nhập bị gián đoạn
          </h2>
          <p className="text-sm text-muted-foreground mt-2">
            Điều này thường xảy ra khi bạn chuyển tab trong Safari. 
            Hãy làm mới phiên để tiếp tục.
          </p>
        </div>
        
        <div className="space-y-2">
          <Button 
            onClick={clearSessionAndReload}
            className="w-full"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Làm mới phiên đăng nhập
          </Button>
          
          <Button 
            onClick={onRetry}
            variant="outline"
            className="w-full"
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Thử lại
          </Button>
        </div>
        
        <p className="text-xs text-center text-muted-foreground">
          Bạn sẽ được đăng nhập lại tự động qua Google
        </p>
      </div>
    </div>
  );
}
