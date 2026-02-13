import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useExpiryStats, useInventoryBatches, useUpdateBatchExpiryOnce } from "@/hooks/useInventory";
import { CalendarClock, AlertTriangle, Save } from "lucide-react";
import { toast } from "sonner";

export function ExpiryStatsDialog() {
  const { data, isLoading } = useExpiryStats();
  const { data: batches = [] } = useInventoryBatches();
  const updateOnce = useUpdateBatchExpiryOnce();
  const [editing, setEditing] = useState<Record<string, string>>({});

  const handleSave = async (batchId: string) => {
    const expiryDate = editing[batchId];
    if (!expiryDate) return;
    try {
      await updateOnce.mutateAsync({ batchId, expiryDate });
      toast.success("Đã cập nhật HSD thành công");
      setEditing((prev) => ({ ...prev, [batchId]: "" }));
    } catch (e: any) {
      toast.error(e?.message || "Không thể cập nhật HSD (mỗi lô chỉ sửa 1 lần)");
    }
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <CalendarClock className="h-4 w-4" />
          Thống kê HSD
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Thống kê hàng hoá theo hạn sử dụng</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Đang tải...</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Quá hạn</CardTitle></CardHeader>
                <CardContent className="text-2xl font-bold text-red-600">{data?.expired || 0}</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">≤ 7 ngày</CardTitle></CardHeader>
                <CardContent className="text-2xl font-bold text-orange-600">{data?.due7 || 0}</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">8-30 ngày</CardTitle></CardHeader>
                <CardContent className="text-2xl font-bold text-yellow-600">{data?.due30 || 0}</CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">An toàn / chưa khai báo</CardTitle></CardHeader>
                <CardContent className="text-2xl font-bold text-green-600">{data?.safe || 0}</CardContent>
              </Card>

              <div className="col-span-2 rounded-lg border p-3 text-sm text-muted-foreground flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5" />
                Tổng số lô theo dõi: <span className="font-semibold text-foreground ml-1">{data?.totalBatches || 0}</span>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <h4 className="font-medium">Danh sách lô gần đây (sửa HSD tối đa 1 lần)</h4>
              <div className="space-y-2">
                {batches.map((b: any) => (
                  <div key={b.id} className="border rounded-lg p-3 grid grid-cols-12 gap-2 items-center text-sm">
                    <div className="col-span-3 font-medium">{b.inventory_items?.name || "-"}</div>
                    <div className="col-span-2">{b.quantity} {b.unit || ""}</div>
                    <div className="col-span-2">{b.expiry_date || "Chưa có"}</div>
                    <div className="col-span-2">Sửa: {b.expiry_edit_count}/1</div>
                    <div className="col-span-3 flex gap-2">
                      <Input
                        type="date"
                        value={editing[b.id] ?? ""}
                        onChange={(e) => setEditing((prev) => ({ ...prev, [b.id]: e.target.value }))}
                        disabled={b.expiry_edit_count >= 1}
                      />
                      <Button size="sm" onClick={() => handleSave(b.id)} disabled={b.expiry_edit_count >= 1 || !editing[b.id]}>
                        <Save className="h-3 w-3 mr-1" />Lưu
                      </Button>
                    </div>
                  </div>
                ))}
                {batches.length === 0 && <div className="text-sm text-muted-foreground">Chưa có dữ liệu lô hàng.</div>}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
