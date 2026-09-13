import { Fragment } from "react";
import { dSku, formatDSku } from "@/i18n/dSku";
import { useDSkuCopy } from "@/i18n/useDSkuCopy";
import { toast as sonnerToast } from "sonner";

type DSkuCopyKey = keyof typeof dSku.en;

type ReactiveDSkuToastTextProps =
  | {
      copyKey: DSkuCopyKey;
      values?: Record<string, string | number>;
      exactText?: never;
    }
  | {
      copyKey?: never;
      values?: never;
      exactText: string;
    };

export function ReactiveDSkuToastText({
  copyKey,
  values,
  exactText,
}: ReactiveDSkuToastTextProps) {
  const copy = useDSkuCopy();
  const text = exactText ?? formatDSku(copy[copyKey!], values ?? {});

  return <Fragment>{text}</Fragment>;
}

function SupplierErrorToastContent({ description }: { description: string }) {
  return (
    <div className="w-full rounded-lg border border-destructive/30 bg-background p-4 text-foreground shadow-lg">
      <div className="font-semibold">
        <ReactiveDSkuToastText copyKey="supplierError" />
      </div>
      <div className="mt-1 text-sm text-muted-foreground" data-description>
        <ReactiveDSkuToastText exactText={description} />
      </div>
    </div>
  );
}

export function showSupplierErrorToast(description: string) {
  return sonnerToast.custom(() => (
    <SupplierErrorToastContent description={description} />
  ));
}
