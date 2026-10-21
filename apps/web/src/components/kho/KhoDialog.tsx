import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The Kho pages' panel: a centred dialog on desktop, a sheet from the bottom edge on a phone.
 * `data` carries the QA hooks (`{ "data-bmq-…": "" }`).
 */
export function KhoDialog({ title, sub, onClose, children, wide = false, data }: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  data?: Record<string, string>;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className={cn("d3-kho-dialog", wide && "is-wide")}
        onOpenAutoFocus={(event) => event.preventDefault()}
        {...data}
      >
        <DialogHeader className="d3-kho-dialog-head">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={sub ? undefined : "sr-only"}>{sub ?? title}</DialogDescription>
        </DialogHeader>
        <div className="d3-kho-dialog-body">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
