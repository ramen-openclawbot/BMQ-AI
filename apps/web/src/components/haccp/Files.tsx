import { useRef, useState } from "react";
import { Camera, FileText, ImageIcon, Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HaccpFile } from "@/lib/haccp-schema";
import { useToast } from "@/hooks/use-toast";
import { HACCP_MAX_FILE_BYTES, fileSize, toHaccpFiles } from "./store";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf,.docx,.xlsx";

export function FileDrop({ hint, onFiles, big = false }: { hint: string; onFiles: (files: HaccpFile[]) => void; big?: boolean }) {
  const pickRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { toast } = useToast();
  const take = (list: FileList | null) => {
    const all = toHaccpFiles(list);
    const files = all.filter((file) => file.size <= HACCP_MAX_FILE_BYTES);
    if (files.length < all.length) toast({ title: "File lớn hơn 10 MB nên chưa thêm", variant: "destructive" });
    if (files.length) onFiles(files);
  };
  return (
    <div
      className={cn("hc-drop", big && "is-big", over && "is-over")}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
    >
      <span className="hc-drop-icon" aria-hidden="true"><Upload /></span>
      <p><b>{hint}</b><small>Ảnh, PDF, Word hoặc Excel · tối đa 10 MB mỗi file<span className="hc-wide-only"> · có thể kéo thả vào đây</span></small></p>
      <div className="hc-drop-acts">
        <button type="button" className="hc-btn is-ink hc-phone-only" onClick={() => cameraRef.current?.click()}><Camera />Chụp ảnh</button>
        <button type="button" className="hc-btn" onClick={() => pickRef.current?.click()}><FileText />Chọn file</button>
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
      <input ref={pickRef} type="file" accept={ACCEPT} multiple className="hidden" onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
    </div>
  );
}

export function FileList_({ files, onRemove }: { files: HaccpFile[]; onRemove?: (id: string) => void }) {
  if (!files.length) return null;
  return (
    <ul className="hc-files">
      {files.map((f) => (
        <li key={f.id}>
          <span className="hc-thumb" aria-hidden="true">
            {f.url && f.type.startsWith("image/") ? <img src={f.url} alt="" /> : f.type.startsWith("image/") ? <ImageIcon /> : <FileText />}
          </span>
          {f.url ? <a className="hc-file-name" href={f.url} target="_blank" rel="noopener noreferrer"><b>{f.name}</b><small>{fileSize(f.size)}</small></a> : <span className="hc-file-name"><b>{f.name}</b><small>{fileSize(f.size)}</small></span>}
          {onRemove ? <button type="button" className="hc-icon-btn" aria-label={`Bỏ ${f.name}`} onClick={() => onRemove(f.id)}><X /></button> : null}
        </li>
      ))}
    </ul>
  );
}
