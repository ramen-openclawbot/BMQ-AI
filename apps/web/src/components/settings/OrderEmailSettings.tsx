import { useEffect, useState } from "react";
import { Link2, Loader2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { SettingsRow, SettingsStatus } from "./SettingsKit";
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
    <SettingsRow
      dataAttr="bmq-order-email-settings"
      label="Email đặt hàng nhà cung cấp"
      hint={connected ? (isOrderMailbox ? connected : `${connected} · cần đăng nhập ${ORDER_MAILBOX}`) : ORDER_MAILBOX}
      value={connected ? (isOrderMailbox ? <SettingsStatus tone="ok">Đã kết nối</SettingsStatus> : <SettingsStatus tone="warn">Sai tài khoản</SettingsStatus>) : <SettingsStatus tone="off">Chưa kết nối</SettingsStatus>}
      action={connected ? (
        <button type="button" className="st-link is-danger" onClick={() => void disconnect()} disabled={busy !== null}>
          {busy === "disconnect" ? <Loader2 className="animate-spin" /> : <Unlink />}Ngắt
        </button>
      ) : (
        <button type="button" className="st-link is-primary" onClick={() => void connect()} disabled={busy !== null} data-bmq-order-email-connect>
          {busy === "connect" ? <Loader2 className="animate-spin" /> : <Link2 />}Kết nối
        </button>
      )}
    />
  );
}
