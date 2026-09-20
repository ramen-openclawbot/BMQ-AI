/**
 * CRITICAL: Safari Deadlock Recovery Screen
 * 
 * This component must NOT import any module that imports Supabase client.
 * It renders BEFORE AppInner is loaded to allow users to clear session
 * when Safari is stuck due to navigator.locks deadlock.
 */

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RefreshCw, Trash2, AlertTriangle } from "lucide-react";
import { clearSessionAndRedirect, clearSessionAndReload } from "@/lib/session-utils";
// Dependency-free (no Supabase): safe to import before AppInner loads.
import { adminHostCopy } from "@/lib/adminHostLanguage";

export function RecoveryScreen() {
  const copy = adminHostCopy();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center">
          <AlertTriangle className="h-16 w-16 text-destructive mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-foreground mb-2">
            {copy.recovery.title}
          </h1>
          <p className="text-muted-foreground">
            {copy.recovery.subtitle}
          </p>
        </div>

        <Alert className="border-warning/50 bg-warning/10">
          <AlertDescription className="text-foreground">
            {copy.recovery.alert}
          </AlertDescription>
        </Alert>

        <div className="space-y-3">
          <Button 
            onClick={clearSessionAndRedirect}
            className="w-full"
            variant="destructive"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            {copy.recovery.clearAndReload}
          </Button>
          
          <Button 
            onClick={clearSessionAndReload}
            className="w-full"
            variant="outline"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            {copy.recovery.plainReload}
          </Button>
        </div>

        <p className="text-xs text-center text-muted-foreground">
          {copy.recovery.footerLine1}
          <br />
          {copy.recovery.footerLine2}
        </p>
      </div>
    </div>
  );
}
