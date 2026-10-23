import { useEffect, useState } from "react";
import { Check, Link2, Loader2, Mail, Unlink, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

const ORDER_MAILBOX = "order@bmq.vn";

/**
 * Gmail account that sends supplier order emails (owner 23/10). Only the
 * order@bmq.vn mailbox may send; any other connected account blocks sending.
 */
export function OrderEmailSettings() {
  const [connected, setConnected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);

  useEffect(() => {
    let alive = true;
    void supabase
      .from("app_settings")
      .select("value")
      .eq("key", "order_gmail_connected_email")
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setConnected(data?.value ? String(data.value) : null);
      });

    const params = new URLSearchParams(window.location.search);
    const ok = params.get("order_gmail_success");
    const failed = params.get("order_gmail_error");
    const email = params.get("order_gmail_email");
    if (ok === "true" || failed) {
      if (ok === "true") {
        if (email) setConnected(email);
        if (email && email.toLowerCase() !== ORDER_MAILBOX) {
          toast.error(`Đã kết nối ${email}, nhưng chỉ hộp thư ${ORDER_MAILBOX} được gửi đơn hàng.`);
        } else {
          toast.success(`Đã kết nối hộp thư ${email || ORDER_MAILBOX}`);
        }
      } else {
        toast.error("Kết nối hộp thư đặt hàng thất bại", { description: failed ?? undefined });
      }
      for (const key of ["order_gmail_success", "order_gmail_error", "order_gmail_email"]) params.delete(key);
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
    return () => {
      alive = false;
    };
  }, []);

  const connect = async () => {
    setBusy("connect");
    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-drive-auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect: window.location.origin, mode: "order_gmail" }),
      });
      const result = await response.json();
      if (result.authUrl) {
        window.location.href = result.authUrl;
        return;
      }
      toast.error("Không mở được trang đăng nhập Google", { description: result.error });
    } catch {
      toast.error("Không mở được trang đăng nhập Google");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    try {
      await supabase.from("app_settings").delete().eq("key", "order_gmail_refresh_token");
      await supabase.from("app_settings").delete().eq("key", "order_gmail_connected_email");
      setConnected(null);
      toast.success("Đã ngắt hộp thư đặt hàng");
    } catch {
      toast.error("Không ngắt được hộp thư đặt hàng");
    } finally {
      setBusy(null);
    }
  };

  const isOrderMailbox = connected?.toLowerCase() === ORDER_MAILBOX;

  return (
    <div className="p-4 border border-border rounded-lg bg-card space-y-3" data-bmq-order-email-settings>
      <Label className="flex items-center gap-2">
        <Mail className="h-4 w-4" />
        Email đặt hàng nhà cung cấp
      </Label>
      {connected ? (
        <div className={`flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 ${isOrderMailbox ? "border-primary/20 bg-primary/5" : "border-destructive/20 bg-destructive/5"}`}>
          <span className="flex min-w-0 items-center gap-2 text-sm">
            {isOrderMailbox ? <Check className="h-5 w-5 shrink-0 text-primary" /> : <X className="h-5 w-5 shrink-0 text-destructive" />}
            <span className="min-w-0 break-all">
              {isOrderMailbox ? "Đang gửi từ " : "Đã kết nối "}
              <strong>{connected}</strong>
              {isOrderMailbox ? "" : ` — cần đăng nhập ${ORDER_MAILBOX}`}
            </span>
          </span>
          <Button variant="outline" size="sm" onClick={() => void disconnect()} disabled={busy !== null}
            className="text-destructive hover:text-destructive hover:bg-destructive/10">
            {busy === "disconnect" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Unlink className="h-4 w-4 mr-1" />}
            Ngắt
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/20 bg-destructive/5 p-3">
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <X className="h-4 w-4 text-destructive" />
            Chưa kết nối {ORDER_MAILBOX}
          </span>
          <Button onClick={() => void connect()} disabled={busy !== null} size="sm" data-bmq-order-email-connect>
            {busy === "connect" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Link2 className="h-4 w-4 mr-1" />}
            Đăng nhập {ORDER_MAILBOX}
          </Button>
        </div>
      )}
    </div>
  );
}
