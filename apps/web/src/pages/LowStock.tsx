import { AlertTriangle, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useLowStockItems } from "@/hooks/useInventory";
import { Skeleton } from "@/components/ui/skeleton";

const getUrgency = (stock: number, minStock: number) => {
  const ratio = stock / minStock;
  if (ratio <= 0.3) return { label: "Critical", className: "border-destructive/50 text-destructive bg-destructive/10" };
  if (ratio <= 0.6) return { label: "High", className: "border-warning/50 text-warning bg-warning/10" };
  return { label: "Medium", className: "border-primary/50 text-primary bg-primary/10" };
};

const LowStock = () => {
  const { data: lowStockItems, isLoading } = useLowStockItems();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-display font-bold text-foreground">
              Low Stock Alerts
            </h1>
            <p className="text-muted-foreground mt-1">
              Items that need to be reordered
            </p>
          </div>
        </div>
        <div className="card-elevated rounded-xl border border-border p-6 space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">
            Low Stock Alerts
          </h1>
          <p className="text-muted-foreground mt-1">
            Items that need to be reordered
          </p>
        </div>
        {lowStockItems && lowStockItems.length > 0 && (
          <button className="btn-gradient px-4 py-2 rounded-lg font-medium flex items-center gap-2">
            <ShoppingCart className="h-4 w-4" />
            Order All
          </button>
        )}
      </div>

      {!lowStockItems?.length ? (
        <div className="card-elevated rounded-xl border border-border p-8 text-center">
          <p className="text-muted-foreground">
            All items are well stocked! No low stock alerts.
          </p>
        </div>
      ) : (
        <div className="card-elevated rounded-xl border border-border overflow-hidden">
          <div className="divide-y divide-border">
            {lowStockItems.map((item) => {
              const urgency = getUrgency(item.quantity, item.min_stock || 0);
              return (
                <div 
                  key={item.id} 
                  className="flex items-center justify-between px-6 py-4 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
                      <AlertTriangle className="h-5 w-5 text-destructive" />
                    </div>
                    <div>
                      <p className="font-medium">{item.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {item.quantity} {item.unit} remaining · Min: {item.min_stock || 0} {item.unit}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <Badge variant="outline" className={urgency.className}>
                      {urgency.label}
                    </Badge>
                    <p className="text-sm text-muted-foreground">{item.category}</p>
                    <Button size="sm" className="btn-gradient">
                      Reorder
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default LowStock;
