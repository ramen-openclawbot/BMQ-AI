/* Chứng từ kèm theo: the supporting documents attached when the phiếu was created. */
import { useState } from "react";
import { FileText } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { usePaymentRequestAttachments } from "@/hooks/usePaymentRequestAttachments";
import "@/styles/bmq-cash-settlement.css";

export function PaymentRequestAttachmentsStrip({ requestId, title = "Chứng từ kèm theo", className }: { requestId: string; title?: string; className?: string }) {
  const { attachments } = usePaymentRequestAttachments(requestId);
  const [zoom, setZoom] = useState<string | null>(null);
  if (attachments.length === 0) return null;
  return (
    <section className={className ? `d3-cs ${className}` : "d3-cs"} data-bmq-pr-attachments={attachments.length}>
      <div className="d3-cs-head"><h3>{title} · {attachments.length}</h3></div>
      <div className="d3-csp-docs">
        {attachments.map((a) =>
          a.url && (a.mime_type ?? "image/").startsWith("image/") ? (
            <button key={a.id} type="button" className="d3-cs-thumb" onClick={() => setZoom(a.url)} aria-label={a.file_name || "Chứng từ"}>
              <img src={a.url} alt={a.file_name || "Chứng từ"} loading="lazy" />
            </button>
          ) : (
            <a key={a.id} className="d3-cs-thumb is-file" href={a.url ?? undefined} target="_blank" rel="noreferrer" aria-label={a.file_name || "Tệp"}>
              <FileText className="m-auto h-5 w-5" />
            </a>
          ),
        )}
      </div>
      <Dialog open={!!zoom} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent className="d3-unc-ev-zoom">
          <DialogTitle className="sr-only">Chứng từ</DialogTitle>
          {zoom && <img src={zoom} alt="Chứng từ" />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
