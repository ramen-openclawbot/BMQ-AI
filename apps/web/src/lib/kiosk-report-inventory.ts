export type ReportInventoryProduct = {
  code: string;
  sale_allowed?: boolean | null;
  breadstick_consumption_ratio?: number | null;
};

export type ReportInventoryRow = {
  openingQuantity: number;
  receivedQuantity: number;
  shortageQuantity: number;
  transferQuantity: number;
  wasteQuantity: number;
  returnsQuantity: number;
  soldQuantity: number;
};

const nonnegative = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
};

const roundInventoryQuantity = (value: number) => Math.round((value + Number.EPSILON) * 1_000) / 1_000;

export const KIOSK_RETAIL_CUSTOMER_UNIT_PRICE_VND = 12_000;

export const calculateKioskChannelAmount = (
  channelCode: string,
  quantity: number,
  enteredAmountVnd: number,
) => String(channelCode || "").trim().toLowerCase() === "khach_le"
  ? Math.round(nonnegative(quantity) * KIOSK_RETAIL_CUSTOMER_UNIT_PRICE_VND)
  : Math.round(nonnegative(enteredAmountVnd));

export const isRetailSaleAllowed = (product?: ReportInventoryProduct | null) => product?.sale_allowed !== false;

export const calculateConsumedQuantity = (
  product: ReportInventoryProduct | null | undefined,
  breadstickSoldQuantity: number,
) => roundInventoryQuantity(
  nonnegative(breadstickSoldQuantity) * nonnegative(product?.breadstick_consumption_ratio),
);

export const calculateEffectiveConsumedQuantity = (
  product: ReportInventoryProduct | null | undefined,
  breadstickSoldQuantity: number,
  manualConsumedQuantity: number,
) => product?.code === "ot"
  ? roundInventoryQuantity(nonnegative(manualConsumedQuantity))
  : calculateConsumedQuantity(product, breadstickSoldQuantity);

export const deriveBreadstickInventoryRow = (
  row: ReportInventoryRow,
  breadstickSoldQuantity: number,
): ReportInventoryRow => ({
  ...row,
  soldQuantity: nonnegative(breadstickSoldQuantity),
});

export const calculateInventoryClosing = (
  row: ReportInventoryRow,
  consumedQuantity = 0,
) => roundInventoryQuantity(
  Number(row.openingQuantity || 0)
  + Number(row.receivedQuantity || 0)
  - Number(row.shortageQuantity || 0)
  + Number(row.transferQuantity || 0)
  - Number(row.wasteQuantity || 0)
  - Number(row.returnsQuantity || 0)
  - Number(row.soldQuantity || 0)
  - nonnegative(consumedQuantity),
);

export const isNegativeInventoryClosing = (
  row: ReportInventoryRow,
  consumedQuantity = 0,
) => calculateInventoryClosing(row, consumedQuantity) < 0;
