import { Plus, FileText, TrendingUp, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";

const actions = [
  { icon: Plus, label: "New Request", description: "Create payment request", path: "/payment-requests" },
  { icon: FileText, label: "Generate Report", description: "Export inventory data", path: null },
  { icon: TrendingUp, label: "View Analytics", description: "Spending insights", path: null },
  { icon: RefreshCw, label: "Sync Inventory", description: "Update stock levels", path: null },
];

export function QuickActions() {
  const navigate = useNavigate();

  const handleClick = (path: string | null) => {
    if (path) {
      navigate(path);
    }
  };

  return (
    <div className="card-elevated rounded-xl border border-border p-6">
      <h3 className="font-display text-lg font-semibold mb-4">Quick Actions</h3>
      <div className="grid grid-cols-2 gap-3">
        {actions.map((action) => (
          <Button
            key={action.label}
            variant="outline"
            className="h-auto flex-col items-start gap-2 p-4 hover:bg-primary/5 hover:border-primary/30 transition-all"
            onClick={() => handleClick(action.path)}
          >
            <action.icon className="h-5 w-5 text-primary" />
            <div className="text-left">
              <p className="font-medium text-foreground">{action.label}</p>
              <p className="text-xs text-muted-foreground font-normal">{action.description}</p>
            </div>
          </Button>
        ))}
      </div>
    </div>
  );
}
