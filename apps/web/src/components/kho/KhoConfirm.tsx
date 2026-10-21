import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export interface KhoConfirmOptions {
  title: string;
  message?: string;
  ok?: string;
  cancel?: string;
  tone?: "danger" | "default";
}

/**
 * `const { confirm, dialog } = useKhoConfirm()`: `await confirm({...})` resolves true on the main
 * button and false on cancel, Esc or a tap outside. Render `dialog` once in the page.
 */
export function useKhoConfirm() {
  const [options, setOptions] = useState<KhoConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((next: KhoConfirmOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false);
    resolver.current = resolve;
    setOptions(next);
  }), []);

  const finish = (value: boolean) => {
    resolver.current?.(value);
    resolver.current = null;
    setOptions(null);
  };

  const dialog = (
    <AlertDialog open={options !== null} onOpenChange={(open) => { if (!open) finish(false); }}>
      <AlertDialogContent className="d3-kho-confirm" data-bmq-kho-confirm>
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title}</AlertDialogTitle>
          {options?.message ? <AlertDialogDescription>{options.message}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => finish(false)} data-bmq-kho-confirm-cancel>{options?.cancel ?? "Thôi"}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(options?.tone === "danger" && "is-danger")}
            onClick={() => finish(true)}
            data-bmq-kho-confirm-ok
          >
            {options?.ok ?? "Đồng ý"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, dialog };
}
