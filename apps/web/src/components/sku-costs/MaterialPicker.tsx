/* Searchable picker for declared NVL (sku_cogs_materials). Replaces a 65-item plain Select:
 * type part of the code or name (diacritics optional) to filter, tap to choose.
 * New NVL are created in Quản trị NVL chuẩn; the empty state links there.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { materialMatchesSearch } from "@/lib/material-search";

export type PickerMaterial = { id: string; material_code: string; canonical_name: string };

type Props = {
  value?: string;
  materials: PickerMaterial[];
  onValueChange: (materialId: string) => void;
  placeholder?: string;
  className?: string;
};

export function MaterialPicker({ value, materials, onValueChange, placeholder = "Chọn NVL đã khai báo", className }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = useMemo(() => materials.find((m) => m.id === value), [materials, value]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          data-bmq-material-picker
          className={cn("h-10 w-full justify-between gap-2 px-3 font-normal", !selected && "text-muted-foreground", className)}
        >
          <span className="min-w-0 truncate text-left">{selected ? `${selected.material_code} - ${selected.canonical_name}` : placeholder}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[260px] p-0" align="start">
        <Command filter={(itemValue, search) => (materialMatchesSearch(itemValue, search) ? 1 : 0)}>
          <CommandInput value={search} onValueChange={setSearch} placeholder="Tìm theo mã hoặc tên NVL…" data-bmq-material-picker-search />
          <CommandList className="max-h-[min(320px,50dvh)]">
            <CommandEmpty>
              <p className="px-3 text-sm">Không thấy NVL này.</p>
              <Link to="/material-master" className="mt-1 inline-block px-3 text-sm text-primary underline" data-bmq-material-picker-create>
                Tạo NVL mới ở Quản trị NVL chuẩn
              </Link>
            </CommandEmpty>
            {materials.map((material) => (
              <CommandItem
                key={material.id}
                value={`${material.material_code} ${material.canonical_name}`}
                onSelect={() => {
                  onValueChange(material.id);
                  setOpen(false);
                  setSearch("");
                }}
                className="min-h-10 gap-2"
              >
                <Check className={cn("h-4 w-4 shrink-0", material.id === value ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 break-words">
                  {material.material_code} - {material.canonical_name}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
