/**
 * One "Tạo duyệt chi" button for the three ways to create a phiếu chi:
 * PO / NCC (AddPaymentRequestDialog), Chi tiền mặt (cash flow) and Chi lương
 * (owner / quyền Chi lương only). Dropdown on desktop, bottom sheet on phones.
 */
import { forwardRef, useState, type ComponentPropsWithoutRef } from "react";
import { Banknote, ChevronDown, FileText, HandCoins, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import "@/styles/bmq-create-menu.css";

export type CreatePaymentChoice = "po" | "cash" | "salary";

interface CreatePaymentMenuProps {
  canSalary: boolean;
  onChoose: (choice: CreatePaymentChoice) => void;
  className?: string;
  isVi?: boolean;
}

const OPTIONS = [
  { key: "po", icon: FileText, vi: ["Đề nghị chi theo PO / NCC", "Có nhà cung cấp, gắn PO và phiếu nhập kho"], en: ["Supplier / PO request", "Supplier, PO and warehouse receipt"] },
  { key: "cash", icon: Banknote, vi: ["Chi tiền mặt", "Khoản chi lẻ — nhân viên ứng tiền rồi tải hoá đơn"], en: ["Cash expense", "Small expenses — staff advance, then upload receipts"] },
  { key: "salary", icon: HandCoins, vi: ["Chi lương", "Lương bếp Q7 và lương lẻ"], en: ["Payroll cash", "Kitchen Q7 and one-off payroll"] },
] as const;

type Option = (typeof OPTIONS)[number];

function OptionRow({ option, isVi }: { option: Option; isVi: boolean }) {
  const [title, sub] = isVi ? option.vi : option.en;
  const Icon = option.icon;
  return (
    <>
      <span className="d3-cm-ico" aria-hidden="true"><Icon className="h-[18px] w-[18px]" /></span>
      <span className="d3-cm-copy">
        <b>{title}</b>
        <small>{sub}</small>
      </span>
    </>
  );
}

const TriggerButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Button> & { label: string }>(
  ({ label, className, ...props }, ref) => (
    <Button ref={ref} className={cn("d3-pa-primary d3-cm-trigger gap-2 whitespace-nowrap", className)} data-bmq-pr-create-menu {...props}>
      <Plus className="h-4 w-4" />
      {label}
      <ChevronDown className="d3-cm-caret h-4 w-4" aria-hidden="true" />
    </Button>
  ),
);
TriggerButton.displayName = "CreatePaymentMenuTrigger";

export function CreatePaymentMenu({ canSalary, onChoose, className, isVi = true }: CreatePaymentMenuProps) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const options = OPTIONS.filter((o) => o.key !== "salary" || canSalary);
  const label = isVi ? "Tạo duyệt chi" : "Create request";

  // Let the menu/sheet finish closing before the chosen dialog takes focus.
  const choose = (choice: CreatePaymentChoice) => window.setTimeout(() => onChoose(choice), 0);

  if (isMobile) {
    return (
      <>
        <TriggerButton label={label} className={className} aria-haspopup="dialog" onClick={() => setSheetOpen(true)} />
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="d3-cm-sheet" data-bmq-pr-create-sheet>
            <SheetHeader className="text-left">
              <SheetTitle>{label}</SheetTitle>
              <SheetDescription>{isVi ? "Chọn loại phiếu cần tạo" : "Choose what to create"}</SheetDescription>
            </SheetHeader>
            <div className="d3-cm-list">
              {options.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  className="d3-cm-item"
                  data-bmq-pr-create-choice={o.key}
                  onClick={() => {
                    setSheetOpen(false);
                    choose(o.key);
                  }}
                >
                  <OptionRow option={o} isVi={isVi} />
                </button>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <TriggerButton label={label} className={className} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="d3-cm-menu" data-bmq-pr-create-dropdown>
        {options.map((o) => (
          <DropdownMenuItem key={o.key} className="d3-cm-item" data-bmq-pr-create-choice={o.key} onSelect={() => choose(o.key)}>
            <OptionRow option={o} isVi={isVi} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
