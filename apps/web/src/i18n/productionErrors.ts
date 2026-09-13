import { type ProductionCopy } from './production';
import { formatText } from './format';

export type ProductionErrorDescriptorValue = string | number | ProductionErrorDescriptor | ProductionErrorDescriptor[];
export type ProductionErrorDescriptor = {
  kind: "production-local-error";
  copyKey: keyof ProductionCopy;
  values?: Record<string, ProductionErrorDescriptorValue>;
};

export function productionErrorDescriptor(
  copyKey: keyof ProductionCopy,
  values?: Record<string, ProductionErrorDescriptorValue>,
): ProductionErrorDescriptor {
  return { kind: "production-local-error", copyKey, values };
}

export class ProductionLocalError extends Error {
  readonly descriptor: ProductionErrorDescriptor;
  readonly cause?: unknown;

  constructor(descriptor: ProductionErrorDescriptor, cause?: unknown) {
    super(String(descriptor.copyKey));
    this.name = "ProductionLocalError";
    this.descriptor = descriptor;
    this.cause = cause;
  }
}

export function localProductionError(
  copyKey: keyof ProductionCopy,
  values?: Record<string, ProductionErrorDescriptorValue>,
  cause?: unknown,
) {
  return new ProductionLocalError(productionErrorDescriptor(copyKey, values), cause);
}

function isProductionErrorDescriptor(value: unknown): value is ProductionErrorDescriptor {
  return Boolean(value) && typeof value === "object" && (value as ProductionErrorDescriptor).kind === "production-local-error";
}

function descriptorFrom(error: unknown): ProductionErrorDescriptor | null {
  if (isProductionErrorDescriptor(error)) return error;
  if (error instanceof ProductionLocalError) return error.descriptor;
  if (error instanceof Error && "cause" in error) return descriptorFrom(error.cause);
  return null;
}

function renderDescriptor(descriptor: ProductionErrorDescriptor, c: ProductionCopy): string {
  const template = String(c[descriptor.copyKey] ?? "");
  if (!descriptor.values) return template;
  const values = Object.fromEntries(Object.entries(descriptor.values).map(([key, value]) => {
    if (Array.isArray(value)) return [key, value.map((entry) => renderDescriptor(entry, c)).join("; ")];
    if (isProductionErrorDescriptor(value)) return [key, renderDescriptor(value, c)];
    return [key, value];
  }));
  return formatText(template, values);
}

// Only explicit descriptors are localized. Backend Error/string text remains verbatim.
export function productionErrorText(error: unknown, c: ProductionCopy, fallback = "") {
  const descriptor = descriptorFrom(error);
  if (descriptor) return renderDescriptor(descriptor, c);
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export const materialErrorText = productionErrorText;
