// Keywords that indicate an item is NOT physical inventory (fees, services, etc.)
export const NON_INVENTORY_KEYWORDS = [
  'vận chuyển', 'van chuyen', 'shipping', 'ship',
  'phí', 'fee',
  'dịch vụ', 'dich vu', 'service',
  'công', 'labor',
  'thuế', 'tax',
  'chiết khấu', 'chiet khau', 'discount',
  'giao hàng', 'giao hang', 'delivery',
  'vat', 'gtgt',
  'phụ phí', 'phu phi',
];

/**
 * Check if a product name represents a physical item that should be tracked in inventory.
 * Returns false for fees, services, shipping, etc.
 */
export function isPhysicalItem(productName: string): boolean {
  if (!productName) return false;
  const lowerName = productName.toLowerCase().trim();
  return !NON_INVENTORY_KEYWORDS.some(keyword => lowerName.includes(keyword));
}
