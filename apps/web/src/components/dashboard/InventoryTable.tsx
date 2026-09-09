import { useWarehouseCopy } from "@/i18n/useWarehouseCopy";
import { useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
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
  const c = useWarehouseCopy();
  const { data: inventory, isLoading, isError, error, refetch } = useInventory();
  const deleteItem = useDeleteInventoryItem();
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  const normalizeText = (text: string) =>
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();

  const filteredInventory = useMemo(() => {
    if (!inventory) return [];
    if (!searchTerm.trim()) return inventory;

    const normalizedSearch = normalizeText(searchTerm);
    return inventory.filter((item) => {
      const values = [item.name, item.category, item.unit].filter(
        (value): value is string => typeof value === "string" && value.length > 0
      );
      return values.some((value) => normalizeText(value).includes(normalizedSearch));
    });
  }, [inventory, searchTerm]);

  const handleDelete = async () => {
    if (!deleteItemId) return;
    try {
      await deleteItem.mutateAsync(deleteItemId);
      toast.success(c("Đã xoá thành công"));
    } catch (error) {
      toast.error(c("Không thể xoá"));
    } finally {
      setDeleteItemId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-display text-lg font-semibold">{c("Tồn kho")}</h3>
          <p className="text-sm text-muted-foreground">{c("Mức tồn nguyên liệu")}</p>
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
          <h3 className="font-display text-lg font-semibold">{c("Tồn kho")}</h3>
          <p className="text-sm text-muted-foreground">{c("Mức tồn nguyên liệu")}</p>
        </div>
        <div className="p-6 space-y-3">
          <p className="font-medium text-foreground">{c("Couldn't load inventory")}</p>
          <p className="text-sm text-muted-foreground break-words">
            {error instanceof Error ? error.message : c("Unknown error")}
          </p>
          <Button variant="outline" onClick={() => refetch()}>
            {c("Retry")} </Button>
        </div>
      </div>
    );
  }

  if (!inventory?.length) {
    return (
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="font-display text-lg font-semibold">{c("Tồn kho")}</h3>
          <p className="text-sm text-muted-foreground">{c("Mức tồn nguyên liệu")}</p>
        </div>
        <p className="text-muted-foreground text-center py-8">
          {c("No inventory items yet. Add your first item to get started.")} </p>
      </div>
    );
  }

  return (
    <>
      <div className="card-elevated rounded-xl border border-border overflow-hidden">
        <div className="px-6 py-4 border-b border-border space-y-3">
          <div>
            <h3 className="font-display text-lg font-semibold">{c("Tồn kho")}</h3>
            <p className="text-sm text-muted-foreground">{c("Mức tồn nguyên liệu")}</p>
          </div>
          <Input
            placeholder={c("Tìm kiếm nguyên liệu, danh mục...")}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{c("Item Name")}</TableHead>
              <TableHead>{c("Category")}</TableHead>
              <TableHead className="text-right">{c("Stock")}</TableHead>
              <TableHead>{c("Status")}</TableHead>
              <TableHead>{c("Min Stock")}</TableHead>
              <TableHead className="text-right">{c("Actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredInventory.length ? (
              filteredInventory.map((item) => {
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
                        {status.variant === "destructive" ? c("Critical") : status.variant === "warning" ? c("Low") : c("In Stock")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{item.min_stock} {item.unit}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={c("Chỉnh sửa nguyên vật liệu")}
                          onClick={() => setEditItem(item)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          aria-label={c("Xoá")}
                          onClick={() => setDeleteItemId(item.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  {c("Không tìm thấy mặt hàng phù hợp.")} </TableCell>
              </TableRow>
            )}
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
            <AlertDialogTitle>{c("Xác nhận xoá")}</AlertDialogTitle>
            <AlertDialogDescription>
              {c("Bạn có chắc muốn xoá mặt hàng này khỏi kho? Hành động này không thể hoàn tác.")} </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{c("Hủy")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {c("Xoá")} </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
