import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: LucideIcon;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  variant?: "default" | "warning" | "success";
}

export function StatCard({ 
  title, 
  value, 
  subtitle, 
  icon: Icon, 
  trend,
  variant = "default" 
}: StatCardProps) {
  const { t } = useLanguage();

  return (
    <div className="stat-card animate-fade-in text-foreground">
      <div className="flex items-start justify-between">
        <div className="text-foreground">
          <p className="text-sm font-medium text-foreground/80">{title}</p>
          <p className="mt-2 text-3xl font-display font-bold text-foreground">
            {value}
          </p>
          {subtitle && (
            <p className="mt-1 text-sm text-foreground/70">{subtitle}</p>
          )}
          {trend && (
            <p className={cn(
              "mt-2 text-sm font-medium",
              trend.isPositive ? "text-success" : "text-destructive"
            )}>
              {trend.isPositive ? "↑" : "↓"} {Math.abs(trend.value)}% {t.dashboardTrendFromLastMonth}
            </p>
          )}
        </div>
        <div className={cn(
          "flex h-12 w-12 items-center justify-center rounded-xl",
          variant === "warning" ? "bg-warning/10" : 
          variant === "success" ? "bg-success/10" : "bg-primary/10"
        )}>
          <Icon className={cn(
            "h-6 w-6",
            variant === "warning" ? "text-warning" : 
            variant === "success" ? "text-success" : "text-primary"
          )} />
        </div>
      </div>
    </div>
  );
}
