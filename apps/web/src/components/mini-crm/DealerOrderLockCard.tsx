/* Khoá đặt hàng (CRM): owner / crm editors lock or unlock one dealer's ordering on
 * dathang.banhmique.vn. Applied immediately through the server RPC, separately from
 * the dialog's Save button, so the session kick and audit row always happen.
 */
import { useState } from "react";
import { Loader2, Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useSetDealerOrderLock } from "@/hooks/useDealerOrderLock";

type Props = {
  customerId: string;
  locked: boolean;
  lockedAt?: string | null;
  reason?: string | null;
  canEdit: boolean;
};

const formatTime = (iso?: string | null) =>
  iso
    ? new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
    : "";

export function DealerOrderLockCard({ customerId, locked, lockedAt, reason, canEdit }: Props) {
  const { toast } = useToast();
  const setLock = useSetDealerOrderLock();
  const [draftReason, setDraftReason] = useState("");
  const [confirming, setConfirming] = useState(false);

  const apply = async (nextLocked: boolean) => {
    try {
      const result = await setLock.mutateAsync({ customerId, locked: nextLocked, reason: nextLocked ? draftReason.trim() || null : null });
      setConfirming(false);
      setDraftReason("");
      toast({
        title: nextLocked ? "Đã khoá đặt hàng" : "Đã mở khoá đặt hàng",
        description: nextLocked
          ? `Đại lý không đăng nhập được trang đặt hàng.${result?.revoked_sessions ? ` Đã đăng xuất ${result.revoked_sessions} phiên đang mở.` : ""}`
          : "Đại lý đăng nhập lại để đặt hàng bình thường.",
      });
    } catch (error) {
      const message = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message) : "";
      toast({
        title: "Chưa đổi được trạng thái khoá",
        description: message.includes("insufficient_privilege") ? "Chỉ chủ hoặc người có quyền sửa CRM được khoá đặt hàng." : "Thử lại sau.",
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className={`space-y-3 rounded-md border p-3 md:col-span-2 ${locked ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30" : ""}`}
      data-bmq-dealer-order-lock={locked ? "locked" : "open"}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {locked ? <Lock className="h-4 w-4 text-red-600" /> : <LockOpen className="h-4 w-4 text-muted-foreground" />}
            Khoá đặt hàng
          </div>
          <p className="text-xs text-muted-foreground">
            {locked
              ? `Đang khoá${lockedAt ? ` từ ${formatTime(lockedAt)}` : ""}${reason ? ` · ${reason}` : ""}. Đại lý thấy thông báo thanh toán công nợ khi đăng nhập dathang.banhmique.vn.`
              : "Dùng khi đại lý chưa thanh toán công nợ: đại lý không đăng nhập được trang đặt hàng, máy đang đăng nhập bị đăng xuất."}
          </p>
        </div>
        {canEdit && locked ? (
          <Button type="button" variant="outline" size="sm" onClick={() => void apply(false)} disabled={setLock.isPending} data-bmq-dealer-order-unlock>
            {setLock.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <LockOpen className="mr-1 h-4 w-4" />}
            Mở khoá
          </Button>
        ) : null}
        {canEdit && !locked && !confirming ? (
          <Button type="button" variant="outline" size="sm" className="border-red-300 text-red-700 hover:bg-red-50" onClick={() => setConfirming(true)} data-bmq-dealer-order-lock-open>
            <Lock className="mr-1 h-4 w-4" /> Khoá đặt hàng
          </Button>
        ) : null}
      </div>

      {canEdit && !locked && confirming ? (
        <div className="space-y-2" data-bmq-dealer-order-lock-confirm>
          <Input
            value={draftReason}
            onChange={(e) => setDraftReason(e.target.value)}
            placeholder="Lý do (không bắt buộc), ví dụ: nợ quá hạn tháng 9"
            maxLength={200}
            aria-label="Lý do khoá đặt hàng"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={setLock.isPending}>Huỷ</Button>
            <Button type="button" variant="destructive" size="sm" onClick={() => void apply(true)} disabled={setLock.isPending} data-bmq-dealer-order-lock-submit>
              {setLock.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Lock className="mr-1 h-4 w-4" />}
              Khoá và đăng xuất đại lý
            </Button>
          </div>
        </div>
      ) : null}
      {!canEdit ? <p className="text-xs text-muted-foreground">Chỉ chủ hoặc người có quyền sửa CRM được đổi.</p> : null}
    </div>
  );
}
