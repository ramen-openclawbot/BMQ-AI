import { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { LogOut, Warehouse } from "lucide-react";

interface WarehouseLayoutProps {
  children: ReactNode;
  userName?: string | null;
  onLogout?: () => void;
  showHeader?: boolean;
}

export function WarehouseLayout({ 
  children, 
  userName, 
  onLogout,
  showHeader = true 
}: WarehouseLayoutProps) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {showHeader && (
        <header className="sticky top-0 z-50 bg-primary text-primary-foreground shadow-md">
          <div className="container max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Warehouse className="h-6 w-6" />
              <span className="font-semibold text-lg">BMQ Kho</span>
            </div>
            {userName && onLogout && (
              <div className="flex items-center gap-3">
                <span className="text-sm opacity-90 hidden sm:inline">
                  {userName}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onLogout}
                  className="text-primary-foreground hover:bg-primary-foreground/10"
                >
                  <LogOut className="h-5 w-5" />
                </Button>
              </div>
            )}
          </div>
        </header>
      )}
      <main className="flex-1 container max-w-lg mx-auto px-4 py-4">
        {children}
      </main>
    </div>
  );
}
