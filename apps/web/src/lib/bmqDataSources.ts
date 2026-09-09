import { z } from "zod";
export const DATA_FILE_LIMIT = 1024 * 1024;
export const DATA_ENTITIES = ["customers", "products", "locations", "orders", "order_items", "payments", "inventory_movements", "inventory_snapshots", "suppliers", "purchases", "employees", "expenses", "conversations", "messages"] as const;
export const dataSourceSchema = z.object({ id: z.string(), source: z.string(), entity: z.string(), filename: z.string(), records: z.number(), status: z.string(), ingested_at: z.string(), kind: z.enum(["dataset", "document"]), error: z.string().optional() });
export const dataSourcesSchema = z.object({ sources: z.array(dataSourceSchema) });
export const dataStatusSchema = z.object({ status: z.literal("ready"), storage: z.object({ total_bytes: z.number(), free_bytes: z.number(), warning: z.string().nullable().optional() }), sources: z.number(), knowledge_documents: z.number(), semantic_version: z.string() });
export type DataSource = z.infer<typeof dataSourceSchema>;
export type DataStatus = z.infer<typeof dataStatusSchema>;
export function validateDataFile(file: Pick<File, "name" | "size">, kind: "dataset" | "document", language: "en" | "vi") {
  const en = language === "en";
  if (file.size > DATA_FILE_LIMIT || file.size === 0) throw new Error(en ? "Choose a non-empty file up to 1 MiB." : "Chọn file có nội dung, tối đa 1 MiB.");
  if (!(kind === "dataset" ? /\.(csv|json)$/i : /\.(md|txt)$/i).test(file.name)) throw new Error(en ? "This file format does not match the selected source type." : "Định dạng file không đúng loại nguồn đã chọn.");
}

export const DATA_REQUIRED_FIELDS: Record<typeof DATA_ENTITIES[number], string> = {
  customers: "id", products: "id", locations: "id", suppliers: "id", employees: "id", conversations: "id", messages: "id",
  orders: "id,status,currency,ordered_at,net_amount",
  order_items: "id,order_id,product_id,quantity,net_amount",
  payments: "id,currency,amount,paid_at",
  inventory_movements: "id,product_id,location_id,event_at,quantity",
  inventory_snapshots: "id,product_id,location_id,snapshot_at,quantity_on_hand",
  purchases: "id,currency,total_amount,ordered_at",
  expenses: "id,currency,amount,expense_at",
};
