import { useFormField } from "@/components/ui/form";
import { useWarehouseCopy } from "@/i18n/useWarehouseCopy";
import type { WarehouseCopyKey } from "@/i18n/warehouse";

// Inventory's schema stores fixed message keys so an open error reacts to language changes.
export function InventoryFormMessage() {
  const { error, formMessageId } = useFormField();
  const c = useWarehouseCopy();
  if (!error?.message) return null;
  return <p id={formMessageId} className="text-sm font-medium text-destructive">{c(error.message as WarehouseCopyKey)}</p>;
}
