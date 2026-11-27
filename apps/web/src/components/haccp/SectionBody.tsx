import { useState } from "react";
import { Database, Paperclip, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { haccpMissing, type HaccpRow, type HaccpSection, type HaccpTable } from "@/lib/haccp-schema";
import { FileDrop, FileList_ } from "./Files";
import { RowDialog } from "./RowDialog";
import type { HaccpLinkedRow, HaccpSupplierPapers } from "@/lib/haccp-api";
import { haccpErrorText, type HaccpStore } from "./store";

const newRow = (who: string): HaccpRow => ({ id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, values: {}, files: [], by: who });

export function SectionBody({ section, store, who, manager, papers = {} }: { section: HaccpSection; store: HaccpStore; who: string; manager: boolean; papers?: Record<string, HaccpSupplierPapers> }) {
  const linked = (row: HaccpRow) => Boolean((row as HaccpLinkedRow).linked);
  const attpChip = (row: HaccpRow) => {
    const p = papers[row.id];
    if (!p || !p.total) return null;
    return <span className={cn("hc-state", p.done >= p.total ? "is-done" : "is-gap")} data-hc-attp-chip>ATTP {p.done}/{p.total}</span>;
  };
  const [editing, setEditing] = useState<{ table: HaccpTable; row: HaccpRow; isNew: boolean } | null>(null);
  const [onlyGaps, setOnlyGaps] = useState(false);
  const { toast } = useToast();
  const [pulling, setPulling] = useState(false);
  const fail = (error: unknown) => toast({ title: "Chưa làm được", description: haccpErrorText(error), variant: "destructive" });
  /** True when the row itself is stored: a failed attachment must not invite a second save. */
  const attempt = async (job: () => void | Promise<void>, done: string) => {
    try {
      await job();
      toast({ title: done });
      return true;
    } catch (error) {
      fail(error);
      return (error as { code?: string } | null)?.code === "attachment_failed";
    }
  };

  if (section.id === "layout") {
    return (
      <div className="hc-layout">
        <FileDrop big hint="Tải bản vẽ mặt bằng bếp Quận 7" onFiles={(files) => void attempt(() => store.addLayoutFiles(files, who), `Đã thêm ${files.length} file layout`)} />
        <FileList_ files={store.layoutFiles} onRemove={(id) => void attempt(() => store.removeLayoutFile(id, who), "Đã bỏ file")} />
        <div className="hc-layout-tips">
          <p><b>Trên bản vẽ nên có</b></p>
          <ul>
            <li>Khu nhận nguyên liệu, kho, khu sơ chế, trộn, ủ, nướng, làm nguội, đóng gói</li>
            <li>Đường đi của nguyên liệu và thành phẩm</li>
            <li>Chỗ rửa tay, thay đồ, để hoá chất, để rác</li>
          </ul>
        </div>
      </div>
    );
  }

  const pull = async (table: HaccpTable) => {
    setPulling(true);
    try {
      const added = await store.pullFromApp(table.id);
      toast(added
        ? { title: `Đã lấy thêm ${added} dòng từ BMQ AI`, description: "Dòng đã có được giữ nguyên." }
        : { title: "Không có gì mới", description: "Dữ liệu trên app đã nằm trong danh sách." });
    } catch (error) {
      fail(error);
    } finally {
      setPulling(false);
    }
  };

  return (
    <>
      <div className="hc-filter" role="tablist" aria-label="Lọc dòng">
        <button type="button" role="tab" aria-selected={!onlyGaps} className={cn(!onlyGaps && "is-on")} onClick={() => setOnlyGaps(false)}>Tất cả</button>
        <button type="button" role="tab" aria-selected={onlyGaps} className={cn(onlyGaps && "is-on")} onClick={() => setOnlyGaps(true)}>Còn thiếu</button>
      </div>

      {section.tables.map((table) => {
        const all = store.data[table.id];
        const rows = onlyGaps ? all.filter((r) => haccpMissing(table, r).length) : all;
        const open = (row: HaccpRow) => setEditing({ table, row, isNew: false });
        const isProcess = table.id === "process";
        // Suppliers come from the catalogue: the staff link only views them.
        const staffSuppliers = !manager && table.id === "suppliers";
        const [first, ...rest] = table.fields.filter((f) => f.required);
        return (
          <div key={table.id} className="hc-block" data-hc-table={table.id}>
            <div className="hc-block-head">
              <h3>{table.title}<small>{all.length} dòng</small></h3>
              <div className="hc-block-acts">
                {manager && table.fromApp ? <button type="button" className="hc-btn" disabled={pulling} onClick={() => void pull(table)} data-hc-pull={table.id}><Database />{pulling ? "Đang lấy…" : "Lấy từ app"}</button> : null}
                {staffSuppliers ? null : <button type="button" className="hc-btn is-ink" onClick={() => setEditing({ table, row: newRow(who), isNew: true })} data-hc-add={table.id}><Plus />Thêm {table.one}</button>}
              </div>
            </div>
            {staffSuppliers ? <p className="hc-staff-note" data-hc-suppliers-readonly>Quản lý cập nhật nhà cung cấp từ danh mục. Thông tin sai hay thiếu, báo quản lý.</p> : null}

            {!rows.length ? (
              <p className="hc-empty">{all.length ? "Không còn dòng nào thiếu thông tin." : `Chưa có ${table.one} nào. Bấm “Thêm ${table.one}” để bắt đầu.`}</p>
            ) : isProcess ? (
              <ol className="hc-flow">
                {rows.map((row) => {
                  const gaps = haccpMissing(table, row);
                  return (
                    <li key={row.id}>
                      <span className={cn("hc-flow-no", !gaps.length && "is-done")}>{all.indexOf(row) + 1}</span>
                      <button type="button" className="hc-flow-card" onClick={() => open(row)} data-hc-row={row.id}>
                        <span className="hc-flow-top">
                          <b>{row.values.step || "Bước chưa đặt tên"}</b>
                          {row.values.owner ? <span className="hc-chip">{row.values.owner}</span> : <span className="hc-gap">Ai làm?</span>}
                        </span>
                        {row.values.detail ? <span className="hc-flow-detail">{row.values.detail}</span> : <span className="hc-gap">Bổ sung mô tả và thông số kiểm soát</span>}
                        {row.files.length ? <span className="hc-clip"><Paperclip />{row.files.length} file</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <>
                <div className="hc-table-wrap hc-wide-only">
                  <table className="hc-table">
                    <thead>
                      <tr>
                        <th className="is-no">STT</th>
                        {table.fields.map((f) => <th key={f.key} className={cn(f.kind === "long" && "is-long", f.kind === "number" && "is-num")}>{f.label}</th>)}
                        <th className="is-file">File</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id} onClick={() => open(row)} data-hc-row={row.id}>
                          <td className="is-no">{all.indexOf(row) + 1}</td>
                          {table.fields.map((f, i) => {
                            const v = row.values[f.key]?.trim();
                            const cell = v ? v : f.required ? <span className="hc-gap">Bổ sung</span> : <span className="hc-dash">–</span>;
                            return (
                              <td key={f.key} className={cn(f.kind === "long" && "is-long", f.kind === "number" && "is-num")}>
                                {i === 0 ? (
                                  <button type="button" className="hc-first" onClick={(e) => { e.stopPropagation(); open(row); }}>
                                    <b>{cell}</b><small>{linked(row) ? "Danh mục Nhà cung cấp" : row.by === "app" ? "Từ BMQ AI" : `${row.by} nhập`}</small>
                                  </button>
                                ) : cell}
                              </td>
                            );
                          })}
                          <td className="is-file">{attpChip(row) ?? (row.files.length ? <span className="hc-clip"><Paperclip />{row.files.length}</span> : <span className="hc-dash">–</span>)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="hc-cards hc-phone-only">
                  {rows.map((row) => {
                    const gaps = haccpMissing(table, row);
                    return (
                      <li key={row.id}>
                        <button type="button" onClick={() => open(row)} data-hc-card={row.id}>
                          <span className="hc-card-top">
                            <b>{row.values[first.key] || "Chưa đặt tên"}</b>
                            <span className={cn("hc-state", gaps.length ? "is-gap" : "is-done")}>{gaps.length ? `Thiếu ${gaps.length}` : "Đủ"}</span>
                          </span>
                          <span className="hc-card-line">{rest.map((f) => (row.values[f.key] && f.kind === "number" ? `${f.label}: ${row.values[f.key]}` : row.values[f.key])).filter(Boolean).slice(0, 3).join(" · ") || "Chưa có thông tin"}</span>
                          {gaps.length ? <span className="hc-card-gaps">Cần: {gaps.map((f) => f.label.toLowerCase()).join(", ")}</span> : null}
                          <span className="hc-card-foot">{linked(row) ? "Danh mục Nhà cung cấp" : row.by === "app" ? "Từ BMQ AI" : `${row.by} nhập`}{attpChip(row) ?? (row.files.length ? <span className="hc-clip"><Paperclip />{row.files.length}</span> : null)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        );
      })}

      {editing ? (
        <RowDialog
          table={editing.table}
          row={editing.row}
          isNew={editing.isNew}
          readOnly={!manager && editing.table.id === "suppliers"}
          linked={manager && linked(editing.row)}
          papers={papers[editing.row.id]}
          onClose={() => setEditing(null)}
          onSave={async (row) => { if (await attempt(() => store.saveRow(editing.table.id, { ...row, by: who }, who), "Đã lưu")) setEditing(null); }}
          onRemove={async () => { if (await attempt(() => store.removeRow(editing.table.id, editing.row.id, who, editing.row.version), "Đã xoá dòng")) setEditing(null); }}
        />
      ) : null}
    </>
  );
}
