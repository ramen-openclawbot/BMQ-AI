import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useInventory, useDeleteInventoryItem, InventoryItem } from "@/hooks/useInventory";
import { Skeleton } from "@/components/ui/skeleton";

import { Pencil, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EditInventoryDialog } from "@/components/dialogs/EditInventoryDialog";
import { toast } from "sonner";

function getStockStatus(stock: number, minStock: number) {
  if (stock <= minStock * 0.5) return { label: "Critical", variant: "destructive" as const };
  if (stock <= minStock) return { label: "Low", variant: "warning" as const };
  return { label: "In Stock", variant: "success" as const };
}

export function InventoryTable() {
  const { data: inventory, isLoading, isError, error, refetch } = useInventory();
  const deleteItem = useDeleteInventoryItem();
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!deleteItemId) return;
    try {
      await deleteItem.mutateAsync(deleteItemId);
      toast.success("Đã xoá thành công");
    } catch (error) {
      toast.error("Không thể xoá");
    } finally {
      setDeleteItemId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-display text-lg font-semibold">Inventory Overview</h3>
          <p className="text-sm text-muted-foreground">Track your ingredient stock levels</p>
        </div>
        <div className="p-6 space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-display text-lg font-semibold">Inventory Overview</h3>
          <p className="text-sm text-muted-foreground">Track your ingredient stock levels</p>
        </div>
        <div className="p-6 space-y-3">
          <p className="font-medium text-foreground">Couldn't load inventory</p>
          <p className="text-sm text-muted-foreground break-words">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
          <Button variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!inventory?.length) {
    return (
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-display text-lg font-semibold">Inventory Overview</h3>
          <p className="text-sm text-muted-foreground">Track your ingredient stock levels</p>
        </div>
        <p className="text-muted-foreground text-center py-8">
          No inventory items yet. Add your first item to get started.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-display text-lg font-semibold">Inventory Overview</h3>
          <p className="text-sm text-muted-foreground">Track your ingredient stock levels</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item Name</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Stock</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Min Stock</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inventory.map((item) => {
              const status = getStockStatus(item.quantity, item.min_stock || 0);
              return (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">{item.name}</TableCell>
                  <TableCell className="text-muted-foreground">{item.category}</TableCell>
                  <TableCell className="text-right font-medium">
                    {item.quantity} {item.unit}
                  </TableCell>
                  <TableCell>
                    <Badge 
                      variant="outline"
                      className={cn(
                        "font-medium",
                        status.variant === "destructive" && "border-destructive/50 text-destructive bg-destructive/10",
                        status.variant === "warning" && "border-warning/50 text-warning bg-warning/10",
                        status.variant === "success" && "border-success/50 text-success bg-success/10"
                      )}
                    >
                      {status.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{item.min_stock} {item.unit}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEditItem(item)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => setDeleteItemId(item.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Edit Dialog */}
      <EditInventoryDialog
        item={editItem}
        open={!!editItem}
        onOpenChange={(open) => !open && setEditItem(null)}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteItemId} onOpenChange={(open) => !open && setDeleteItemId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc muốn xoá mặt hàng này khỏi kho? Hành động này không thể hoàn tác.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
