import { useEffect, useMemo, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading";
import { OptionPicker } from "@/components/OptionPicker";
import { useKhoAuditLog } from "@/hooks/useKhoAudit";
import { useKhoItems } from "@/hooks/useKhoItems";
import { KHO_AUDIT_KIND_LABELS, type KhoAuditRow } from "@/lib/kho-audit";
import { KHO_AUDIT_GROUPS, auditLines, dayHeading, groupByDay, vnTime, type KhoAuditGroupId } from "@/lib/kho-audit-view";
import { KHO_LABEL, todayVN } from "@/components/kho/kho-meta";
import { cn } from "@/lib/utils";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-kho.css";
import "@/styles/bmq-kho-audit.css";

/**
 * Nhật ký kho (owner 27/10): who did what in the warehouse and when, for checking and reconciling.
 * One feed from kho_get_audit_log: item edits (before → after), receipts, counts, adjustments and transfers.
 * Read-only; newest first, grouped by Vietnam day, filtered by date, person, item and kind of action.
 */

const deniedText = (error: unknown) => {
  const raw = error as { code?: string; message?: string } | null;
  return raw?.code === "42501" || /insufficient_privilege|actor_required/.test(raw?.message ?? "")
    ? "Tài khoản này chưa có quyền xem nhật ký kho."
    : "Không tải được nhật ký kho. Thử lại sau ít giây.";
};

function AuditRow({ row }: { row: KhoAuditRow }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => auditLines(row), [row]);
  const place = row.location ? `Kho ${KHO_LABEL[row.location]}` : null;
  return (
    <li className="d3-ka-row" data-bmq-audit-row={row.kind}>
      <button type="button" className="d3-ka-main" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="d3-ka-time">{vnTime(row.occurred_at)}</span>
        <span className="d3-ka-body">
          <b>{row.item_name ?? "Không gắn món"}</b>
          <span className="d3-ka-sum">{row.summary}</span>
          <small>
            <span className="d3-ka-kind">{KHO_AUDIT_KIND_LABELS[row.kind]}</span>
            <span className={cn(!row.actor_name && "is-system")}>{row.actor_name ?? (row.actor_id ? "Người dùng khác" : "Hệ thống")}</span>
            {place ? <span>{place}</span> : null}
          </small>
        </span>
        <ChevronDown className={cn("d3-ka-chev", open && "is-open")} aria-hidden="true" />
      </button>
      {open ? (
        <dl className="d3-ka-detail" data-bmq-audit-detail>
          {lines.length ? lines.map((line) => (
            <div key={`${line.label}-${line.text}`}><dt>{line.label}</dt><dd>{line.text}</dd></div>
          )) : <div><dt>Chi tiết</dt><dd>Không có thêm thông tin.</dd></div>}
        </dl>
      ) : null}
    </li>
  );
}

export default function KhoAuditLog() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [group, setGroup] = useState<KhoAuditGroupId>("all");
  const [itemId, setItemId] = useState("");
  const [actorId, setActorId] = useState("");
  const [seen, setSeen] = useState<Record<string, string>>({});
  const items = useKhoItems();
  const kinds = KHO_AUDIT_GROUPS.find((g) => g.id === group)?.kinds ?? null;
  const log = useKhoAuditLog({ from: from || null, to: to || null, actorId: actorId || null, itemId: itemId || null, kinds });
  const rows = useMemo(() => (log.data?.pages ?? []).flatMap((page) => page.items), [log.data]);
  const days = useMemo(() => groupByDay(rows), [rows]);
  const today = todayVN();

  // The people picker is built from whoever has appeared in the feed so far.
  useEffect(() => {
    const add: Record<string, string> = {};
    for (const row of rows) if (row.actor_id && row.actor_name && !seen[row.actor_id]) add[row.actor_id] = row.actor_name;
    if (Object.keys(add).length) setSeen((prev) => ({ ...prev, ...add }));
  }, [rows, seen]);

  const itemOptions = useMemo(() => (items.data?.items ?? []).map((it) => ({ value: it.id, label: it.name })).sort((a, b) => a.label.localeCompare(b.label, "vi")), [items.data]);
  const actorOptions = useMemo(() => Object.entries(seen).map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "vi")), [seen]);
  const filtered = Boolean(from || to || itemId || actorId || group !== "all");
  const clear = () => { setFrom(""); setTo(""); setItemId(""); setActorId(""); setGroup("all"); };

  return (
    <div className="d3-wh d3-kho min-w-0" data-bmq-kho-audit>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>Nhật ký kho</h1>
          <p className="d3-wh-tag">Ai làm gì trên kho, lúc nào · mới nhất ở trên</p>
        </div>
      </header>

      <section className="d3-wh-card d3-kho-card d3-ka-filters" aria-label="Lọc nhật ký" data-bmq-audit-filters>
        <div className="d3-kho-seg" role="group" aria-label="Loại thao tác" data-bmq-audit-groups>
          {KHO_AUDIT_GROUPS.map((g) => (
            <button key={g.id} type="button" aria-pressed={group === g.id} className={cn(group === g.id && "is-on")} onClick={() => setGroup(g.id)} data-bmq-audit-group={g.id}>{g.label}</button>
          ))}
        </div>
        <div className="d3-ka-fields">
          <label className="d3-kho-field"><span>Từ ngày</span><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Từ ngày" data-bmq-audit-from /></label>
          <label className="d3-kho-field"><span>Đến ngày</span><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Đến ngày" data-bmq-audit-to /></label>
          <div className="d3-kho-field d3-ka-pick"><span>Món</span>
            <OptionPicker value={itemId} onChange={setItemId} options={itemOptions} title="Lọc theo món" ariaLabel="Lọc theo món" placeholder={items.isLoading ? "Đang tải món…" : "Tất cả món"} dataAttrs={{ "bmq-audit-item": "" }} />
          </div>
          <div className="d3-kho-field d3-ka-pick"><span>Người làm</span>
            <OptionPicker value={actorId} onChange={setActorId} options={actorOptions} title="Lọc theo người" ariaLabel="Lọc theo người" placeholder={actorOptions.length ? "Tất cả mọi người" : "Chưa có ai trong danh sách"} disabled={actorOptions.length === 0 && !actorId} dataAttrs={{ "bmq-audit-actor": "" }} />
          </div>
        </div>
        {filtered ? <Button variant="ghost" size="sm" className="d3-ka-clear" onClick={clear} data-bmq-audit-clear><RotateCcw aria-hidden="true" />Xoá lọc</Button> : null}
      </section>

      <section className="d3-wh-card d3-kho-card" data-bmq-audit-feed>
        {log.isLoading ? (
          <LoadingState rows={6} flat label="Đang tải nhật ký…" />
        ) : log.isError ? (
          <div className="d3-kho-failed" role="alert"><p>{deniedText(log.error)}</p><Button variant="outline" onClick={() => void log.refetch()}>Thử lại</Button></div>
        ) : rows.length === 0 ? (
          <p className="d3-kho-empty" data-bmq-audit-empty>{filtered ? "Không có thao tác nào khớp bộ lọc." : "Chưa có thao tác nào được ghi."}</p>
        ) : (
          <>
            {days.map((day) => (
              <div key={day.day} className="d3-ka-day">
                <h2 className="d3-ka-dayhead">{dayHeading(day.day, today)}<span>{day.rows.length}</span></h2>
                <ul className="d3-kho-list d3-ka-list">{day.rows.map((row) => <AuditRow key={row.key} row={row} />)}</ul>
              </div>
            ))}
            {log.hasNextPage ? (
              <div className="d3-ka-more">
                <Button variant="outline" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()} data-bmq-audit-more>{log.isFetchingNextPage ? "Đang tải…" : "Xem thêm"}</Button>
              </div>
            ) : <p className="d3-kho-quiet d3-ka-end">Đã hết nhật ký.</p>}
          </>
        )}
        {log.isFetchNextPageError ? <p className="d3-kho-error">Không tải thêm được. Bấm Xem thêm để thử lại.</p> : null}
      </section>
    </div>
  );
}
