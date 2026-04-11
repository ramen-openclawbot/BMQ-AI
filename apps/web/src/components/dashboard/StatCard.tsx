import { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardDescription } from "@/components/ui/card";

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
    <Card className="animate-fade-in border-border bg-card text-card-foreground shadow-sm">
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <CardDescription className="flex items-center gap-1 text-sm">{title}</CardDescription>
            <div className="mt-2 text-2xl font-bold text-card-foreground">
              {value}
            </div>
            {subtitle && (
              <CardDescription className="mt-1">{subtitle}</CardDescription>
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
      </CardContent>
    </Card>
  );
}
