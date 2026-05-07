import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { KitchenItem } from "@/hooks/useKitchenInventory";
import { money } from "@/lib/kitchen-inventory/calculations";
import { normalizeKitchenText } from "@/lib/kitchen-inventory/normalize";

interface ItemMasterTabProps {
  items: KitchenItem[];
  loading: boolean;
}

export function ItemMasterTab({ items, loading }: ItemMasterTabProps) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<"all" | KitchenItem["item_type"]>("all");

  const filteredItems = useMemo(() => {
    const normalizedSearch = normalizeKitchenText(search);
    return items.filter((item) => {
      const matchesType = type === "all" || item.item_type === type;
      const matchesSearch = !normalizedSearch || normalizeKitchenText(`${item.item_code} ${item.name} ${item.unit}`).includes(normalizedSearch);
      return matchesType && matchesSearch;
    });
  }, [items, search, type]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Danh mục chuẩn kho bếp</h2>
            <p className="text-sm text-muted-foreground">
              Tên, đơn vị và giá chuẩn được ghi đè từ dòng APPROVE của file kế toán.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search..."
                className="h-9 rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <select
              value={type}
              onChange={(event) => setType(event.target.value as typeof type)}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">Tất cả nhóm</option>
              <option value="ingredient">Nguyên liệu</option>
              <option value="tool_supply">CCDC/Vật tư</option>
            </select>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:hidden">
        {filteredItems.map((item) => (
          <div key={item.id} className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs text-muted-foreground">{item.item_code}</div>
                <div className="font-semibold">{item.name}</div>
              </div>
              <span className="rounded-full bg-muted px-2 py-1 text-xs">
                {item.item_type === "ingredient" ? "NVL" : "CCDC"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-muted-foreground">ĐVT</div>
                <div>{item.unit}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Giá chuẩn</div>
                <div>{money(item.standard_unit_cost)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-xl border bg-card shadow-sm md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Mã</th>
                <th className="px-4 py-3">Nhóm</th>
                <th className="px-4 py-3">Tên chuẩn</th>
                <th className="px-4 py-3">ĐVT</th>
                <th className="px-4 py-3 text-right">Giá chuẩn</th>
                <th className="px-4 py-3">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>Đang tải danh mục...</td>
                </tr>
              )}
              {!loading && filteredItems.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>Chưa có item chuẩn.</td>
                </tr>
              )}
              {!loading && filteredItems.map((item) => (
                <tr key={item.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium">{item.item_code}</td>
                  <td className="px-4 py-3">{item.item_type === "ingredient" ? "Nguyên liệu" : "CCDC/Vật tư"}</td>
                  <td className="px-4 py-3">{item.name}</td>
                  <td className="px-4 py-3">{item.unit}</td>
                  <td className="px-4 py-3 text-right">{money(item.standard_unit_cost)}</td>
                  <td className="px-4 py-3">{item.active ? "Active" : "Inactive"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
