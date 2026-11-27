import { useState } from "react";
import { Trash2 } from "lucide-react";
import { KhoDialog } from "@/components/kho/KhoDialog";
import { cn } from "@/lib/utils";
import { haccpMissing, type HaccpRow, type HaccpTable } from "@/lib/haccp-schema";
import { FileDrop, FileList_ } from "./Files";

export function RowDialog({ table, row, isNew, onSave, onRemove, onClose }: {
  table: HaccpTable;
  row: HaccpRow;
  isNew: boolean;
  onSave: (row: HaccpRow) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<HaccpRow>(row);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await job(); } finally { setBusy(false); }
  };
  const set = (key: string, value: string) => setDraft((d) => ({ ...d, values: { ...d.values, [key]: value } }));
  const missing = haccpMissing(table, draft);
  const empty = !table.fields.some((f) => String(draft.values[f.key] ?? "").trim()) && !draft.files.length;

  return (
    <KhoDialog
      title={isNew ? `Thêm ${table.one}` : draft.values[table.fields[0].key] || `Sửa ${table.one}`}
      sub={missing.length ? `Còn thiếu ${missing.length} thông tin · lưu trước rồi bổ sung sau cũng được` : "Đã đủ thông tin"}
      onClose={onClose}
      wide
      data={{ "data-hc-row-dialog": table.id }}
    >
      <div className="hc-form">
        {table.fields.map((f) => {
          const value = draft.values[f.key] ?? "";
          const gap = Boolean(f.required) && !value.trim();
          return (
            <div key={f.key} className={cn("hc-field", (f.kind === "long" || f.kind === "yesno") && "is-full", gap && !isNew && "is-gap")}>
              <label htmlFor={`hc-${f.key}`}>{f.label}{f.required ? null : <em> (không bắt buộc)</em>}</label>
              {f.kind === "yesno" ? (
                <div className="hc-yesno" role="group" aria-label={f.label}>
                  {["Có", "Không"].map((v) => (
                    <button key={v} type="button" aria-pressed={value === v} className={cn(value === v && "is-on")} onClick={() => set(f.key, value === v ? "" : v)}>{v}</button>
                  ))}
                </div>
              ) : f.kind === "long" ? (
                <textarea id={`hc-${f.key}`} rows={3} maxLength={600} value={value} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input id={`hc-${f.key}`} maxLength={f.kind === "phone" ? 40 : 160} value={value} placeholder={f.placeholder} inputMode={f.kind === "number" ? "numeric" : f.kind === "phone" ? "tel" : "text"} onChange={(e) => set(f.key, e.target.value)} />
              )}
            </div>
          );
        })}
      </div>

      {table.fileHint ? (
        <div className="hc-attach">
          <FileDrop hint={table.fileHint} onFiles={(files) => setDraft((d) => ({ ...d, files: [...d.files, ...files] }))} />
          <FileList_ files={draft.files} onRemove={(id) => setDraft((d) => ({ ...d, files: d.files.filter((f) => f.id !== id) }))} />
        </div>
      ) : null}

      <div className="hc-dialog-acts">
        {!isNew ? (
          asking ? (
            <span className="hc-confirm">
              Xoá dòng này?
              <button type="button" className="hc-btn is-danger" disabled={busy} onClick={() => void run(onRemove)}>Xoá</button>
              <button type="button" className="hc-btn" onClick={() => setAsking(false)}>Giữ lại</button>
            </span>
          ) : <button type="button" className="hc-btn is-quiet" onClick={() => setAsking(true)}><Trash2 />Xoá dòng</button>
        ) : <span />}
        <span className="hc-dialog-main">
          <button type="button" className="hc-btn" onClick={onClose}>Thôi</button>
          <button type="button" className="hc-btn is-ink" disabled={empty || busy} onClick={() => void run(() => onSave(draft))} data-hc-row-save>{busy ? "Đang lưu…" : "Lưu"}</button>
        </span>
      </div>
    </KhoDialog>
  );
}
