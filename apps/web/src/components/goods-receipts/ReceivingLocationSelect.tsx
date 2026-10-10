import { useToast } from "@/hooks/use-toast";
import { useSetGoodsReceiptReceivingLocation } from "@/hooks/useStockLedger";
import type { StockLedgerLocation } from "@/lib/stock-ledger";
import { cn } from "@/lib/utils";

/** Kho nhận hàng of one goods receipt; the choice is also remembered for its supplier. */
export function ReceivingLocationSelect({
  receiptId,
  value,
  className,
}: {
  receiptId: string;
  value: string | null | undefined;
  className?: string;
}) {
  const { toast } = useToast();
  const setLocation = useSetGoodsReceiptReceivingLocation();
  const current = value === "q7" || value === "tan_tao" ? value : "";

  return (
    <select
      aria-label="Kho nhận hàng"
      data-bmq-receiving-location
      className={cn(
        "h-8 max-w-[132px] rounded-lg border bg-background px-2 text-xs font-medium",
        current ? "border-border text-foreground" : "border-amber-400 text-amber-700",
        className,
      )}
      value={current}
      disabled={setLocation.isPending}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onChange={(event) => {
        const location = event.target.value as StockLedgerLocation;
        if (!location) return;
        setLocation.mutate(
          { receiptId, location },
          {
            onSuccess: () =>
              toast({ title: "Đã chọn kho nhận", description: location === "q7" ? "Kho Q7" : "Kho Tân Tạo" }),
            onError: (error) =>
              toast({
                title: "Chưa đổi được kho nhận",
                description: String((error as { message?: string })?.message ?? error).includes("insufficient_privilege")
                  ? "Tài khoản chưa có quyền ghi sổ kho này."
                  : String((error as { message?: string })?.message ?? error),
                variant: "destructive",
              }),
          },
        );
      }}
    >
      <option value="" disabled>Chọn kho…</option>
      <option value="q7">Kho Q7</option>
      <option value="tan_tao">Kho Tân Tạo</option>
    </select>
  );
}
