export type CostValueMode = "amount" | "percent_of_material";

export type CostTemplateLine = {
  key: string;
  label: string;
  mode: CostValueMode;
  block:
    | "material"
    | "material-adjustment"
    | "production"
    | "sales-admin"
    | "pricing";
  order: number;
  editable?: boolean;
};

export const DEFAULT_SKU_COST_TEMPLATE: CostTemplateLine[] = [
  {
    key: "material_provision_percent",
    label: "Dự phòng hao hụt/tăng giá (%)",
    mode: "percent_of_material",
    block: "material-adjustment",
    order: 10,
    editable: true,
  },
  {
    key: "packaging_cost",
    label: "Cost bao bì",
    mode: "amount",
    block: "production",
    order: 20,
    editable: true,
  },
  {
    key: "labor_cost",
    label: "Cost nhân công",
    mode: "amount",
    block: "production",
    order: 30,
    editable: true,
  },
  {
    key: "delivery_cost",
    label: "Delivery cost",
    mode: "amount",
    block: "production",
    order: 40,
    editable: true,
  },
  {
    key: "other_production_cost",
    label: "Other production cost",
    mode: "amount",
    block: "production",
    order: 50,
    editable: true,
  },
  {
    key: "sga_cost",
    label: "Chi phí bán hàng & quản lý",
    mode: "amount",
    block: "sales-admin",
    order: 60,
    editable: true,
  },
  {
    key: "selling_price",
    label: "Giá bán",
    mode: "amount",
    block: "pricing",
    order: 70,
    editable: true,
  },
];

export const DEFAULT_SKU_COST_VALUES: Record<string, number> = {
  material_provision_percent: 0,
  packaging_cost: 0,
  labor_cost: 0,
  delivery_cost: 0,
  other_production_cost: 0,
  sga_cost: 0,
  selling_price: 0,
};

export const toNumber = (value: unknown, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const parseCostTemplate = (value: unknown): CostTemplateLine[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return [...DEFAULT_SKU_COST_TEMPLATE];
  }

  const lines = value
    .filter((item) => item && typeof item === "object")
    .map((item: any) => ({
      key: String(item.key || ""),
      label: String(item.label || ""),
      mode: item.mode === "percent_of_material" ? "percent_of_material" : "amount",
      block: item.block || "production",
      order: toNumber(item.order, 999),
      editable: item.editable !== false,
    }))
    .filter((line) => line.key && line.label);

  return lines.length > 0
    ? lines.sort((a, b) => a.order - b.order)
    : [...DEFAULT_SKU_COST_TEMPLATE];
};

export const parseCostValues = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_SKU_COST_VALUES };
  }

  const raw = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  Object.keys(raw).forEach((key) => {
    result[key] = toNumber(raw[key], 0);
  });

  return {
    ...DEFAULT_SKU_COST_VALUES,
    ...result,
  };
};
