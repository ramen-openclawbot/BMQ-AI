export type SKUType = "raw_material" | "finished_good";

type MaybeSku = {
  sku_type?: SKUType | null;
  category?: string | null;
};

const normalize = (v: string) =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

export const isFinishedSku = (sku: MaybeSku): boolean => {
  if (sku?.sku_type) return sku.sku_type === "finished_good";
  const c = normalize(String(sku?.category || ""));
  return c.includes("thanh pham") || c.includes("finished");
};

export const isRawMaterialSku = (sku: MaybeSku): boolean => !isFinishedSku(sku);
