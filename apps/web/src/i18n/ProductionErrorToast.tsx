import { useProductionCopy } from "@/i18n/useProductionCopy";
import {
  localProductionError,
  productionErrorText,
  type ProductionErrorDescriptorValue,
} from "@/i18n/productionErrors";
import type { ProductionCopy } from "@/i18n/production";
import { toast as sonnerToast } from "sonner";

type ProductionErrorBoundary =
  | "material-mutation"
  | "material-supplier-confirm"
  | "material-payment-sync"
  | "material-resolution"
  | "material-controller-mode"
  | "q7-check"
  | "q7-upload"
  | "q7-confirm";

type ErrorToastSpec = {
  titleKey: keyof ProductionCopy;
  fallbackKey: keyof ProductionCopy;
};

const errorToastSpecs: Record<ProductionErrorBoundary, ErrorToastSpec> = {
  "material-mutation": { titleKey: "m121", fallbackKey: "m122" },
  "material-supplier-confirm": { titleKey: "m152", fallbackKey: "m153" },
  "material-payment-sync": { titleKey: "m203", fallbackKey: "m204" },
  "material-resolution": { titleKey: "m247", fallbackKey: "m248" },
  "material-controller-mode": { titleKey: "m397", fallbackKey: "m398" },
  "q7-check": { titleKey: "m499", fallbackKey: "m500" },
  "q7-upload": { titleKey: "m508", fallbackKey: "m509" },
  "q7-confirm": { titleKey: "m521", fallbackKey: "m490" },
};

function ReactiveErrorToastText({ spec, field, error }: {
  spec: ErrorToastSpec;
  field: "title" | "description";
  error: unknown;
}) {
  const copy = useProductionCopy();
  if (field === "title") return String(copy[spec.titleKey]);
  return productionErrorText(error, copy, String(copy[spec.fallbackKey]));
}

function ProductionErrorToastContent({ spec, error }: { spec: ErrorToastSpec; error: unknown }) {
  return (
    <div className="w-full rounded-lg border border-destructive/30 bg-background p-4 text-foreground shadow-lg" data-production-error-toast>
      <div className="font-semibold" data-production-error-toast-title><ReactiveErrorToastText spec={spec} field="title" error={error} /></div>
      <div className="mt-1 text-sm text-muted-foreground" data-production-error-toast-description><ReactiveErrorToastText spec={spec} field="description" error={error} /></div>
    </div>
  );
}

/** Dispatches the eight scoped production failures to AppInner's mounted Sonner host. */
export function productionErrorToast(boundary: ProductionErrorBoundary, error: unknown) {
  const spec = errorToastSpecs[boundary];
  return sonnerToast.custom(() => <ProductionErrorToastContent spec={spec} error={error} />);
}

// Exported for the lightweight behavior contract without exposing descriptor internals to consumers.
export const localProductionErrorForToast = (
  copyKey: keyof ProductionCopy,
  values?: Record<string, ProductionErrorDescriptorValue>,
  cause?: unknown,
) => localProductionError(copyKey, values, cause);
