/* Chứng từ kèm theo phiếu chi lương (bảng lương…): ảnh, PDF hoặc Excel. Files live in the private
 * salary-documents bucket; the page only gets short-lived links from the salary-payout edge.
 * SalaryAttachmentPicker collects files on the create form (uploaded once the phiếu exists);
 * SalaryAttachmentsCard lists, opens, adds and removes them on the payout page.
 */
import { useRef, useState } from "react";
import { FileSpreadsheet, FileText, ImageIcon, Loader2, Paperclip, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { useSalaryPayoutAttachments, type SalaryAttachmentUploadInput } from "@/hooks/useSalaryPayoutAttachments";
import { attachmentKind, MAX_COUNT, resolveSalaryAttachmentMime, validateSalaryAttachmentFiles, type SalaryPayoutAttachment } from "@/lib/salary-attachments";
import { cn } from "@/lib/utils";

export const SALARY_ATTACHMENT_ACCEPT = "image/*,.pdf,.xls,.xlsx,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.readAsDataURL(file);
  });

export async function toSalaryUploadInputs(files: File[]): Promise<SalaryAttachmentUploadInput[]> {
  return Promise.all(files.map(async (f) => ({ name: f.name, type: f.type, size: f.size, image_base64: await readAsDataUrl(f) })));
}

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const KIND_LABEL = { image: "Ảnh", pdf: "PDF", excel: "Excel" } as const;

function KindIcon({ mime }: { mime: string }) {
  const kind = attachmentKind(mime);
  if (kind === "excel") return <FileSpreadsheet className="h-5 w-5" />;
  if (kind === "pdf") return <FileText className="h-5 w-5" />;
  return <ImageIcon className="h-5 w-5" />;
}

/** Keeps only files the edge will accept; tells the user about the rest. */
function acceptFiles(list: FileList | null, existing: number): File[] {
  const files = Array.from(list ?? []);
  const check = validateSalaryAttachmentFiles(files.map((f) => ({ name: f.name, type: f.type, size: f.size })), existing);
  if (check.errors.length) toast.error(`${check.errors[0].fileName}: ${check.errors[0].message}${check.errors.length > 1 ? ` (+${check.errors.length - 1})` : ""}`);
  return check.accepted.map((a) => files[a.index]);
}

/* Create form: choose files now, upload after the phiếu is created. */
export function SalaryAttachmentPicker({ files, onChange, disabled }: { files: File[]; onChange: (files: File[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="d3-sal-docs" data-bmq-salary-docs-picker>
      <div className="d3-cs-head"><h3>Chứng từ kèm theo{files.length ? ` · ${files.length}` : ""}</h3></div>
      <input
        ref={ref}
        type="file"
        multiple
        accept={SALARY_ATTACHMENT_ACCEPT}
        className="sr-only"
        data-bmq-salary-docs-file
        onChange={(e) => {
          onChange([...files, ...acceptFiles(e.target.files, files.length)]);
          e.currentTarget.value = "";
        }}
      />
      {files.length > 0 && (
        <ul className="d3-sal-doc-list">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} data-bmq-salary-doc-pending>
              <span className="d3-sal-doc-ico"><KindIcon mime={resolveSalaryAttachmentMime(f.name, f.type) ?? ""} /></span>
              <span className="d3-sal-doc-name"><b>{f.name}</b><small>{sizeText(f.size)}</small></span>
              <button type="button" className="d3-cs-x" aria-label={`Bỏ ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))} disabled={disabled}>
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length < MAX_COUNT && (
        <button type="button" className="d3-sal-doc-add" onClick={() => ref.current?.click()} disabled={disabled} data-bmq-salary-docs-pick>
          <Paperclip className="h-4 w-4" />
          <span>{files.length ? "Thêm chứng từ" : "Đính kèm bảng lương, chứng từ"}</span>
          <small>Ảnh, PDF hoặc Excel · tối đa 10 MB</small>
        </button>
      )}
    </div>
  );
}

/* Payout page: list, open, add and remove. */
export function SalaryAttachmentsCard({
  payoutId,
  attachments,
  canAdd,
  onOpenImage,
}: {
  payoutId: string;
  attachments: SalaryPayoutAttachment[];
  canAdd: boolean;
  onOpenImage: (url: string) => void;
}) {
  const { user, isOwner } = useAuth();
  const { uploadSalaryAttachments, removeSalaryAttachment, getSalaryAttachmentUrl } = useSalaryPayoutAttachments();
  const [busy, setBusy] = useState<string>("");
  const ref = useRef<HTMLInputElement>(null);

  const add = async (list: FileList | null) => {
    const files = acceptFiles(list, attachments.length);
    if (!files.length) return;
    setBusy("upload");
    try {
      const result = await uploadSalaryAttachments(payoutId, await toSalaryUploadInputs(files));
      if (result.uploaded.length) toast.success(`Đã đính kèm ${result.uploaded.length} chứng từ.`);
      if (result.failed.length) toast.error(`${result.failed[0].fileName}: ${result.failed[0].message}`);
    } catch {
      toast.error("Không tải được chứng từ. Thử lại.");
    } finally {
      setBusy("");
    }
  };

  const open = async (a: SalaryPayoutAttachment) => {
    const kind = attachmentKind(a.mime_type);
    // Open the tab inside the tap so iOS Safari does not block it as a popup.
    const tab = kind === "image" ? null : window.open("", "_blank");
    setBusy(a.id);
    try {
      const url = await getSalaryAttachmentUrl(a.id);
      if (kind === "image") onOpenImage(url);
      else if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (err) {
      tab?.close();
      toast.error(err instanceof Error && err.message ? err.message : "Không mở được chứng từ.");
    } finally {
      setBusy("");
    }
  };

  const remove = async (a: SalaryPayoutAttachment) => {
    setBusy(`x-${a.id}`);
    try {
      await removeSalaryAttachment(a.id);
      toast.success("Đã bỏ chứng từ.");
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : "Không bỏ được chứng từ.");
    } finally {
      setBusy("");
    }
  };

  if (!attachments.length && !canAdd) return null;
  return (
    <section className="d3-csp-card d3-cs d3-sal-docs" aria-label="Chứng từ kèm theo" data-bmq-salary-docs>
      <div className="d3-cs-head"><h3>Chứng từ kèm theo{attachments.length ? ` · ${attachments.length}` : ""}</h3></div>
      {attachments.length > 0 ? (
        <ul className="d3-sal-doc-list">
          {attachments.map((a) => {
            const kind = attachmentKind(a.mime_type);
            const mayRemove = canAdd && (isOwner || a.uploaded_by === user?.id);
            return (
              <li key={a.id} data-bmq-salary-doc={kind ?? "file"}>
                <button type="button" className="d3-sal-doc-open" onClick={() => void open(a)} disabled={!!busy} aria-label={`Mở ${a.file_name}`}>
                  <span className={cn("d3-sal-doc-ico", kind && `is-${kind}`)}>{busy === a.id ? <Loader2 className="h-5 w-5 animate-spin" /> : <KindIcon mime={a.mime_type} />}</span>
                  <span className="d3-sal-doc-name">
                    <b>{a.file_name}</b>
                    <small>{kind ? KIND_LABEL[kind] : "File"} · {sizeText(a.size_bytes)}{kind === "excel" ? " · bấm để tải" : ""}</small>
                  </span>
                </button>
                {mayRemove && (
                  <button type="button" className="d3-cs-x" aria-label={`Bỏ ${a.file_name}`} onClick={() => void remove(a)} disabled={!!busy} data-bmq-salary-doc-remove>
                    {busy === `x-${a.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="d3-unc-ev-note">Chưa có chứng từ. Đính kèm bảng lương để đối chiếu.</p>
      )}
      {canAdd && attachments.length < MAX_COUNT && (
        <>
          <input ref={ref} type="file" multiple accept={SALARY_ATTACHMENT_ACCEPT} className="sr-only" data-bmq-salary-docs-file onChange={(e) => { void add(e.target.files); e.currentTarget.value = ""; }} />
          <button type="button" className="d3-sal-doc-add" onClick={() => ref.current?.click()} disabled={!!busy} data-bmq-salary-docs-pick>
            {busy === "upload" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            <span>{busy === "upload" ? "Đang tải lên…" : "Thêm chứng từ"}</span>
            <small>Ảnh, PDF hoặc Excel · tối đa 10 MB</small>
          </button>
        </>
      )}
    </section>
  );
}
