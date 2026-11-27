import { useState } from "react";
import { Download, FileSpreadsheet, FolderArchive } from "lucide-react";
import { KhoDialog } from "@/components/kho/KhoDialog";
import { cn } from "@/lib/utils";
import { HACCP_SECTIONS, haccpProgress, type HaccpSectionId } from "@/lib/haccp-schema";
import { HACCP_EXCEL_FILE_NAME, haccpSheetColumns } from "@/lib/haccp-export";
import type { HaccpStore } from "./store";

const LETTERS = "ABCDEFGHIJ";

/** What the workbook will look like: the template's sheets and columns, filled with the dossier. */
export function ExportPreview({ store, start, onClose, onDownload, paperCount = 0 }: {
  store: HaccpStore;
  /** Supplier ATTP papers the ZIP adds from the vault. */
  paperCount?: number;
  start: HaccpSectionId;
  onClose: () => void;
  onDownload: (zip: boolean) => void | Promise<void>;
}) {
  const [id, setId] = useState<HaccpSectionId>(start);
  const [busy, setBusy] = useState<"xlsx" | "zip" | null>(null);
  const download = async (zip: boolean) => {
    setBusy(zip ? "zip" : "xlsx");
    try { await onDownload(zip); } finally { setBusy(null); }
  };
  const section = HACCP_SECTIONS.find((s) => s.id === id)!;
  const gaps = HACCP_SECTIONS.reduce((n, s) => n + haccpProgress(s, store.data, store.layoutFiles).missingCells, 0);
  const fileCount = paperCount + store.layoutFiles.length + Object.values(store.data).flat().reduce((n, r) => n + r.files.length, 0);

  return (
    <KhoDialog title="Xem trước file Excel" sub="Giữ đúng 7 sheet và các cột của mẫu đơn vị tư vấn gửi" onClose={onClose} wide data={{ "data-hc-export": "" }}>
      <div className="hc-xl">
        <div className="hc-xl-bar"><FileSpreadsheet aria-hidden="true" /><span>{HACCP_EXCEL_FILE_NAME}</span></div>
        <div className="hc-xl-scroll">
          {section.id === "layout" ? (
            <table>
              <thead><tr><th /><th>E</th></tr></thead>
              <tbody>
                <tr><td className="is-rn">3</td><td className="is-head">Đính kèm file layout nhà xưởng mới nhất (nếu có)</td></tr>
                {store.layoutFiles.length ? store.layoutFiles.map((f, i) => <tr key={f.id}><td className="is-rn">{4 + i}</td><td>{f.name}</td></tr>) : <tr><td className="is-rn">4</td><td className="is-gap">chưa có file</td></tr>}
              </tbody>
            </table>
          ) : section.tables.map((table) => {
            const sheet = haccpSheetColumns(table.id);
            const fields = sheet.columns.map(({ key, column }) => ({ column, field: table.fields.find((f) => f.key === key)! }));
            const head = sheet.firstDataRow - 1;
            return (
              <table key={table.id}>
                <caption>{table.title}</caption>
                <thead>
                  <tr><th /><th>{LETTERS[sheet.sttColumn - 1]}</th>{fields.map(({ column, field }) => <th key={field.key}>{LETTERS[column - 1]}</th>)}</tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="is-rn">{head}</td>
                    <td className="is-head">Stt</td>
                    {fields.map(({ field }) => <td key={field.key} className="is-head">{field.label}</td>)}
                  </tr>
                  {store.data[table.id].map((row, i) => (
                    <tr key={row.id}>
                      <td className="is-rn">{sheet.firstDataRow + i}</td>
                      <td className="is-stt">{i + 1}</td>
                      {fields.map(({ field }) => <td key={field.key} className={cn(field.required && !row.values[field.key]?.trim() && "is-gap")}>{row.values[field.key]}</td>)}
                    </tr>
                  ))}
                  {!store.data[table.id].length ? <tr><td className="is-rn">{sheet.firstDataRow}</td><td className="is-stt" />{fields.map(({ field }) => <td key={field.key} className="is-gap" />)}</tr> : null}
                </tbody>
              </table>
            );
          })}
        </div>
        <div className="hc-xl-tabs" role="tablist" aria-label="Sheet">
          {HACCP_SECTIONS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === id} className={cn(s.id === id && "is-on")} onClick={() => setId(s.id)} data-hc-sheet={s.id}>{s.sheet}</button>
          ))}
        </div>
      </div>

      <div className="hc-export-foot">
        <p>{gaps ? <><b>Còn {gaps} ô trống</b> (tô vàng). Vẫn xuất được, ô trống để nguyên trong file.</> : <><b>Đã đủ thông tin.</b> Sẵn sàng gửi đơn vị tư vấn.</>}</p>
        <div>
          <button type="button" className="hc-btn" disabled={busy !== null} onClick={() => void download(true)} data-hc-zip><FolderArchive />{busy === "zip" ? "Đang đóng gói…" : `ZIP kèm ${fileCount} file`}</button>
          <button type="button" className="hc-btn is-ink" disabled={busy !== null} onClick={() => void download(false)} data-hc-download><Download />{busy === "xlsx" ? "Đang tạo file…" : "Tải file Excel"}</button>
        </div>
      </div>
    </KhoDialog>
  );
}
