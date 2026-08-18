import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { KitchenItem } from "@/hooks/useKitchenInventory";
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
      const canonical = canonicalFor(item);
      const matchesType = type === "all" || item.item_type === type;
      const matchesSearch = !normalizedSearch || normalizeKitchenText(`${item.item_code} ${item.name} ${item.unit} ${canonical?.material_code || ""} ${canonical?.canonical_name || ""} ${canonical?.default_unit || ""}`).includes(normalizedSearch);
      return matchesType && matchesSearch;
    });
  }, [items, search, type]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Danh mục liên kết chuẩn kho bếp</h2>
            <p className="text-sm text-muted-foreground">
              Chỉ đọc: mỗi dòng là link kho bếp tới vật tư chuẩn trung tâm; vận hành chỉ dùng để chọn đúng tên và đơn vị location.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Tìm theo mã, tên chuẩn, đơn vị..."
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring sm:w-[260px]"
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
        {filteredItems.map((item) => {
          const canonical = canonicalFor(item);
          return <div key={item.id} className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">{canonical?.material_code || item.item_code}</div>
                <div className="break-words font-semibold">{canonical?.canonical_name || "Chưa liên kết chuẩn"}</div>
                <div className="mt-1 break-words text-xs text-muted-foreground">Location: {item.name}</div>
              </div>
              <span className="rounded-full bg-muted px-2 py-1 text-xs">
                {item.item_type === "ingredient" ? "NVL" : "CCDC"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-muted-foreground">Đơn vị chuẩn</div>
                <div>{canonical?.default_unit || "—"}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Đơn vị location</div>
                <div>{item.unit}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Trạng thái</div>
                <div>{item.active ? "Đang dùng" : "Ngưng dùng"}</div>
              </div>
            </div>
          </div>
        })}
      </div>

      <div className="hidden overflow-hidden rounded-xl border bg-card shadow-sm md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Mã chuẩn</th>
                <th className="px-4 py-3">Nhóm</th>
                <th className="px-4 py-3">Tên chuẩn trung tâm</th>
                <th className="px-4 py-3">Tên location</th>
                <th className="px-4 py-3">Đơn vị chuẩn</th>
                <th className="px-4 py-3">Đơn vị location</th>
                <th className="px-4 py-3">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>Đang tải danh mục...</td>
                </tr>
              )}
              {!loading && filteredItems.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>Chưa có item chuẩn.</td>
                </tr>
              )}
              {!loading && filteredItems.map((item) => {
                const canonical = canonicalFor(item);
                return <tr key={item.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium">{canonical?.material_code || item.item_code}</td>
                  <td className="px-4 py-3">{item.item_type === "ingredient" ? "Nguyên liệu" : "CCDC/Vật tư"}</td>
                  <td className="px-4 py-3"><div className="max-w-[260px] break-words">{canonical?.canonical_name || "Chưa liên kết chuẩn"}</div></td>
                  <td className="px-4 py-3"><div className="max-w-[240px] break-words">{item.name}</div></td>
                  <td className="px-4 py-3">{canonical?.default_unit || "—"}</td>
                  <td className="px-4 py-3">{item.unit}</td>
                  <td className="px-4 py-3">{item.active ? "Đang dùng" : "Ngưng dùng"}</td>
                </tr>
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function canonicalFor(item: KitchenItem) {
  return Array.isArray(item.canonical_materials) ? item.canonical_materials[0] : item.canonical_materials;
}
