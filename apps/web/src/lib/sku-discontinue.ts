/** True when the SKU carries a discontinued timestamp ("Ngưng kinh doanh", owner 22/10). */
export function isSkuDiscontinued(sku: { discontinued_at?: string | null }): boolean {
  return sku.discontinued_at != null;
}
