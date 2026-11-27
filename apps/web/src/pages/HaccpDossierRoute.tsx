import { useEffect } from "react";
import { LoadingState } from "@/components/ui/loading";
import { useAuth } from "@/contexts/AuthContext";
import { haccpErrorText } from "@/components/haccp/store";
import { useHaccp } from "@/hooks/useHaccp";
import { useToast } from "@/hooks/use-toast";
import HaccpDossier from "@/pages/HaccpDossier";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-haccp.css";

/** /warehouse/ho-so-haccp: the dossier on real data, for people who may edit Kho. */
export default function HaccpDossierRoute({ embedded = false }: { embedded?: boolean }) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const haccp = useHaccp({ mode: "manage" });
  useEffect(() => { if (!embedded) window.scrollTo(0, 0); }, [embedded]);

  if (!haccp.ready) {
    if (haccp.error) {
      return (
        <div className="hc hc-wait" role="alert" data-hc-error>
          <h2>Chưa mở được Hồ sơ HACCP</h2>
          <p>{haccpErrorText(haccp.error)}</p>
          <button type="button" className="hc-btn is-ink" onClick={() => void haccp.refetch()}>Thử lại</button>
        </div>
      );
    }
    return <LoadingState label="Đang đọc hồ sơ HACCP" />;
  }

  return (
    <HaccpDossier
      store={haccp.store}
      embedded={embedded}
      who={profile?.full_name?.trim() || "Quản lý"}
      onOpenStaff={() => { if (haccp.store.link.url) window.open(haccp.store.link.url, "_blank", "noopener"); }}
      onDownload={async (zip) => {
        try {
          await (zip ? haccp.exportZip() : haccp.exportExcel());
          toast({ title: zip ? "Đã tải file ZIP" : "Đã tải file Excel" });
        } catch (error) {
          toast({ title: "Chưa xuất được file", description: haccpErrorText(error), variant: "destructive" });
        }
      }}
    />
  );
}
