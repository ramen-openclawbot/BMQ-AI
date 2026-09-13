import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { clearSessionAndReload } from "@/lib/session-utils";

interface SessionRecoveryOverlayProps {
  onRetry: () => void;
}

export function SessionRecoveryOverlay({ onRetry }: SessionRecoveryOverlayProps) {
  const { messages: { staff: s } } = useLanguage();
  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-background rounded-lg shadow-xl max-w-sm w-full p-6 space-y-4">
        <div className="text-center">
          <AlertTriangle className="h-12 w-12 text-amber-500 dark:text-amber-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-foreground">
            {s.session_interrupted}
          </h2>
          <p className="text-sm text-muted-foreground mt-2">
            {s.this_can_happen_when_switching_safari_tabs_refresh_your_session_to_continue}
          </p>
        </div>
        
        <div className="space-y-2">
          <Button 
            onClick={clearSessionAndReload}
            className="w-full"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            {s.refresh_sign_in_session}
          </Button>
          
          <Button 
            onClick={onRetry}
            variant="outline"
            className="w-full"
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            {s.try_again}
          </Button>
        </div>
        
        <p className="text-xs text-center text-muted-foreground">
          {s.you_will_be_signed_in_again_automatically_through_google}
        </p>
      </div>
    </div>
  );
}
