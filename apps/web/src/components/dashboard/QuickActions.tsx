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
    <div className="card-elevated rounded-xl border border-border p-6 text-foreground">
      <h3 className="font-display text-lg font-semibold mb-4 text-foreground">{t.dashboardQuickActions}</h3>
      <div className="grid grid-cols-2 gap-3">
        {actions.map((action) => (
          <Button
            key={action.label}
            variant="outline"
            className="h-auto flex-col items-start gap-2 p-4 hover:bg-primary/5 hover:border-primary/30 transition-all text-left !text-foreground [&_svg]:text-primary"
            onClick={() => handleClick(action.path)}
          >
            <action.icon className="h-5 w-5" />
            <div className="text-left text-foreground">
              <p className="font-medium text-foreground">{action.label}</p>
              <p className="text-xs text-muted-foreground font-normal">{action.description}</p>
            </div>
          </Button>
        ))}
      </div>
    </div>
  );
}
