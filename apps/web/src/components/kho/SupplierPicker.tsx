import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { KhoSupplierOption } from "@/hooks/useKhoItemSuppliers";
import { searchKey } from "@/lib/kho-items";
import { cn } from "@/lib/utils";

const SHOWN = 8;

/**
 * Multi-select of suppliers for one kho item. Selected suppliers stay on top as chips. With none chosen yet the
 * first few suppliers are offered; once one is chosen the list only opens for a typed name (owner 31/10: a
 * chosen supplier must not sit above a long list). Merged suppliers ("[ĐÃ GỘP] …") are never offered.
 */
export function SupplierPicker({ options, value, onChange, disabled, loading }: {
  options: KhoSupplierOption[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const matches = useMemo(() => {
    const key = searchKey(query);
    if (!key && value.length) return [];
    const live = options.filter((o) => !/^\s*\[đã gộp\]/i.test(o.name) && !value.includes(o.id));
    const pool = key ? live.filter((o) => searchKey(o.name).includes(key)) : live;
    return pool.slice(0, SHOWN);
  }, [options, query, value]);
  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    setQuery("");
  };

  return (
    <div className="d3-kho-sup" data-bmq-kho-supplier-picker>
      {value.length ? (
        <ul className="d3-kho-sup-chips" aria-label="Nhà cung cấp đã chọn">
          {value.map((id) => (
            <li key={id}>
              <span>{byId.get(id)?.name ?? "Nhà cung cấp"}</span>
              <button type="button" disabled={disabled} onClick={() => toggle(id)} aria-label={`Bỏ ${byId.get(id)?.name ?? "nhà cung cấp"}`}><X /></button>
            </li>
          ))}
        </ul>
      ) : null}
      {disabled ? null : (
        <>
          <label className="d3-kho-sup-search">
            <Search aria-hidden="true" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={value.length ? "Thêm nhà cung cấp khác…" : "Tìm nhà cung cấp…"} aria-label="Tìm nhà cung cấp" data-bmq-kho-supplier-search />
          </label>
          {loading ? <p className="d3-kho-quiet">Đang tải danh sách…</p> : !query.trim() && value.length ? null : matches.length === 0 ? <p className="d3-kho-quiet">Không thấy nhà cung cấp phù hợp.</p> : (
            <div className="d3-kho-sup-list" role="group" aria-label="Chọn nhà cung cấp">
              {matches.map((o) => {
                const on = value.includes(o.id);
                return (
                  <button key={o.id} type="button" role="checkbox" aria-checked={on} className={cn("d3-kho-check d3-kho-sup-row", on && "is-on")} onClick={() => toggle(o.id)} data-bmq-kho-supplier-pick={o.id}>
                    <span className="d3-kho-check-box" aria-hidden="true"><Check /></span>
                    <span>{o.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
