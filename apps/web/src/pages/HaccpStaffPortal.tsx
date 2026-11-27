import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { haccpErrorText } from "@/components/haccp/store";
import { useHaccp } from "@/hooks/useHaccp";
import HaccpStaffUpload from "@/pages/HaccpStaffUpload";
import "@/styles/bmq-shell.css";
import "@/styles/bmq-haccp.css";

const queryClient = new QueryClient();

function Blocked({ title, text, retry }: { title: string; text: string; retry?: () => void }) {
  // Added here, not once in Portal: leaving the upload screen removes the theme class.
  useEffect(() => {
    document.documentElement.classList.add("bmq-d3");
    return () => document.documentElement.classList.remove("bmq-d3");
  }, []);
  return (
    <main className="hc hc-staff" data-hc-staff-blocked>
      <div className="hc-wait" role="alert">
        <h2>{title}</h2>
        <p>{text}</p>
        {retry ? <button type="button" className="hc-btn is-ink" onClick={retry}>Thử lại</button> : null}
      </div>
    </main>
  );
}

function Portal({ token }: { token: string }) {
  const haccp = useHaccp({ mode: "link", token });
  if (!token) return <Blocked title="Thiếu link" text="Mở đúng link quản lý gửi trong nhóm Zalo của bếp." />;
  // A revoked or expired link stops showing data, even if it loaded earlier.
  const code = (haccp.error as { code?: string } | null)?.code ?? "";
  if (haccp.error && (!haccp.ready || code.startsWith("link_"))) {
    return <Blocked title="Chưa mở được hồ sơ" text={haccpErrorText(haccp.error)} retry={() => void haccp.refetch()} />;
  }
  if (!haccp.ready) return <Blocked title="Đang mở hồ sơ…" text="Chờ một chút." />;
  return <HaccpStaffUpload store={haccp.store} />;
}

/** /nop-ho-so?t=<token>: the staff link. No login and none of the internal app providers. */
export default function HaccpStaffPortal({ token }: { token: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Portal token={token} />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
