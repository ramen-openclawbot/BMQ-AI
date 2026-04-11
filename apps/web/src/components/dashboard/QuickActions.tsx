import { useLanguage } from "@/contexts/LanguageContext";
import { Plus, FileText, TrendingUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";

export function QuickActions() {
  const navigate = useNavigate();
  const { t } = useLanguage();

  const actions = [
    { icon: Plus, label: t.dashboardNewRequest, description: t.dashboardNewRequestDesc, path: "/payment-requests" },
    { icon: FileText, label: t.dashboardGenerateReport, description: t.dashboardGenerateReportDesc, path: null },
    { icon: TrendingUp, label: t.dashboardViewAnalytics, description: t.dashboardViewAnalyticsDesc, path: null },
    { icon: RefreshCw, label: t.dashboardSyncInventory, description: t.dashboardSyncInventoryDesc, path: null },
  ];

  const handleClick = (path: string | null) => {
    if (path) {
      navigate(path);
    }
  };

  return (
    <div className="card-elevated rounded-xl border border-border overflow-hidden">
      <div className="px-6 py-4 border-b border-border">
        <h3 className="font-display text-lg font-semibold text-card-foreground">{t.dashboardQuickActions}</h3>
      </div>
      <div className="grid grid-cols-2 gap-3 p-6">
        {actions.map((action) => (
          <Button
            key={action.label}
            variant="outline"
            className="h-auto flex-col items-start gap-2 border-border bg-card p-4 text-left text-card-foreground hover:bg-muted/40 hover:text-card-foreground"
            onClick={() => handleClick(action.path)}
          >
            <action.icon className="h-5 w-5 text-primary" />
            <div className="text-left">
              <p className="font-medium text-card-foreground">{action.label}</p>
              <p className="text-xs text-card-foreground/70 font-normal">{action.description}</p>
            </div>
          </Button>
        ))}
      </div>
    </div>
  );
}
