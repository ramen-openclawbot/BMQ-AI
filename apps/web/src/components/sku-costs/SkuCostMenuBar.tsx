import { useLanguage } from "@/contexts/LanguageContext";
import { NavLink } from "react-router-dom";
import { BarChart3, LineChart, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

const skuCostMenuItems = [
  { to: "/sku-costs/dashboard", label: "cogs_overview", icon: BarChart3 },
  { to: "/sku-costs/analysis", label: "cogs_trends", icon: LineChart },
  { to: "/sku-costs/management", label: "sku_management", icon: Settings2 },
] as const;

export function SkuCostMenuBar() {
  const { messages: { skuCosts: s } } = useLanguage();
  return (
    <div className="sticky top-0 z-10 -mx-1 overflow-x-auto bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:static md:bg-transparent md:p-0">
      <div className="flex min-w-max gap-2 rounded-2xl border border-border/70 bg-card/80 p-1 shadow-sm md:inline-flex">
        {skuCostMenuItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )
              }
            >
              <Icon className="h-4 w-4" />
              <span>{s[item.label]}</span>
            </NavLink>
          );
        })}
      </div>
    </div>
  );
}
