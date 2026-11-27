import { useState } from "react";
import { Check, Copy, ExternalLink, ShieldCheck } from "lucide-react";
import { KhoDialog } from "@/components/kho/KhoDialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { haccpErrorText, type HaccpStore } from "./store";

export function ShareDialog({ store, onClose, onPreview }: { store: HaccpStore; onClose: () => void; onPreview: () => void }) {
  const [days, setDays] = useState(store.link.days);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<"revoke" | "replace" | null>(null);
  const { toast } = useToast();
  const run = async (job: () => void | Promise<void>) => {
    setBusy(true);
    try { await job(); setAsking(null); } catch (error) { toast({ title: "Chưa làm được", description: haccpErrorText(error), variant: "destructive" }); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(store.link.url); } catch { /* clipboard blocked: the link stays selectable */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <KhoDialog title="Link cho nhân viên" sub="Mở trên điện thoại là nhập được, không cần tài khoản" onClose={onClose} data={{ "data-hc-share": "" }}>
      {store.link.active ? (
        <>
          {store.link.url ? (
            <div className="hc-link">
              <code>{store.link.url}</code>
              <button type="button" className="hc-btn is-ink" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? "Đã chép" : "Chép link"}</button>
            </div>
          ) : (
            <p className="hc-note" data-hc-link-hidden>Link đang mở được tạo trên máy khác nên máy này không xem lại được. Dùng link đã gửi, hoặc tạo link mới (link cũ sẽ tắt).</p>
          )}
          <p className="hc-note">Hết hạn ngày <b>{store.link.expiresOn}</b>. Gửi vào nhóm Zalo của bếp.</p>
          <ul className="hc-rights">
            <li><ShieldCheck />Nhân viên xem, thêm, sửa và tải ảnh cho hồ sơ HACCP.</li>
            <li><ShieldCheck />Không xuất được file, không thấy lương, tiền hay trang khác.</li>
          </ul>
          <div className="hc-dialog-acts">
            {asking ? (
              <span className="hc-confirm">
                {asking === "revoke" ? "Nhân viên sẽ không vào được nữa. Thu hồi?" : "Link cũ sẽ tắt. Tạo link mới?"}
                <button type="button" className="hc-btn is-danger" disabled={busy} onClick={() => void run(() => (asking === "revoke" ? store.revokeLink() : store.createLink(store.link.days)))} data-hc-link-confirm>{asking === "revoke" ? "Thu hồi" : "Tạo mới"}</button>
                <button type="button" className="hc-btn" disabled={busy} onClick={() => setAsking(null)}>Giữ nguyên</button>
              </span>
            ) : <button type="button" className="hc-btn is-quiet" onClick={() => setAsking("revoke")} data-hc-link-revoke>Thu hồi link</button>}
            <span className="hc-dialog-main">
              {store.link.url
                ? <button type="button" className="hc-btn" onClick={onPreview} data-hc-staff-open><ExternalLink />Xem trang nhân viên</button>
                : <button type="button" className="hc-btn" onClick={() => setAsking("replace")} data-hc-link-replace>Tạo link mới</button>}
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="hc-note">Chưa có link nào đang mở. Link đã thu hồi hoặc hết hạn không dùng lại được.</p>
          <div className="hc-field is-full">
            <label>Thời hạn</label>
            <div className="hc-yesno" role="group" aria-label="Thời hạn link">
              {[7, 30, 90].map((d) => <button key={d} type="button" aria-pressed={days === d} className={cn(days === d && "is-on")} onClick={() => setDays(d)}>{d} ngày</button>)}
            </div>
          </div>
          <div className="hc-dialog-acts"><span /><span className="hc-dialog-main"><button type="button" className="hc-btn is-ink" disabled={busy} onClick={() => void run(() => store.createLink(days))} data-hc-link-create>{busy ? "Đang tạo…" : "Tạo link mới"}</button></span></div>
        </>
      )}
    </KhoDialog>
  );
}
