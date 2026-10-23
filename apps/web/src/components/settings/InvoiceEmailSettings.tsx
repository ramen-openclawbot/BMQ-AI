import { useEffect, useState } from "react";
import { Link2, Loader2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { SettingsRow, SettingsStatus } from "./SettingsKit";
import { supabase } from "@/integrations/supabase/client";

const INVOICE_MAILBOX = "hoadon@bmq.vn";

/**
 * Read-only Gmail inbox for incoming invoices (owner 23/10). The worker
 * invoice-inbox-ingest reads it every 30 minutes and drafts pending payment
 * requests; google-drive-auth refuses any account other than hoadon@bmq.vn.
 */
export function InvoiceEmailSettings() {
  const [connected, setConnected] = useState<string | null>(null);
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);

  useEffect(() => {
    let alive = true;
    void supabase
      .from("app_settings")
      .select("value")
      .eq("key", "invoice_gmail_connected_email")
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setConnected(data?.value ? String(data.value) : null);
      });

    const params = new URLSearchParams(window.location.search);
    const ok = params.get("invoice_gmail_success");
    const failed = params.get("invoice_gmail_error");
    const email = params.get("invoice_gmail_email");
    if (ok === "true" || failed) {
      if (ok === "true") {
        if (email) setConnected(email);
        toast.success(`Đã kết nối hộp thư ${email || INVOICE_MAILBOX}`);
      } else if (failed === "wrong_account") {
        toast.error(`Chỉ nhận hộp thư ${INVOICE_MAILBOX}. Anh đăng nhập lại đúng tài khoản nhé.`);
      } else {
        toast.error("Kết nối hộp thư hóa đơn thất bại", { description: failed ?? undefined });
      }
      for (const key of ["invoice_gmail_success", "invoice_gmail_error", "invoice_gmail_email"]) params.delete(key);
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
        body: JSON.stringify({ redirect: window.location.origin, mode: "invoice_gmail" }),
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
      await supabase.from("app_settings").delete().eq("key", "invoice_gmail_refresh_token");
      await supabase.from("app_settings").delete().eq("key", "invoice_gmail_connected_email");
      setConnected(null);
      toast.success("Đã ngắt hộp thư hóa đơn");
    } catch {
      toast.error("Không ngắt được hộp thư hóa đơn");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsRow
      dataAttr="bmq-invoice-email-settings"
      label="Email nhận hóa đơn"
      hint={connected ? `${connected} · tự lập đề nghị chi chờ duyệt` : `${INVOICE_MAILBOX} · tự lập đề nghị chi chờ duyệt`}
      value={connected ? <SettingsStatus tone="ok">Đã kết nối</SettingsStatus> : <SettingsStatus tone="off">Chưa kết nối</SettingsStatus>}
      action={connected ? (
        <button type="button" className="st-link is-danger" onClick={() => void disconnect()} disabled={busy !== null}>
          {busy === "disconnect" ? <Loader2 className="animate-spin" /> : <Unlink />}Ngắt
        </button>
      ) : (
        <button type="button" className="st-link is-primary" onClick={() => void connect()} disabled={busy !== null} data-bmq-invoice-email-connect>
          {busy === "connect" ? <Loader2 className="animate-spin" /> : <Link2 />}Kết nối
        </button>
      )}
    />
  );
}
