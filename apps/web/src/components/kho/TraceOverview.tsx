import { Link } from "react-router-dom";
import { AlertTriangle, Check, ChevronRight, ClipboardList, Clock, FileSearch, FileWarning, Hourglass, PackageCheck, ShieldCheck, Workflow } from "lucide-react";
import { useAttpChecklist } from "@/hooks/useKhoAttp";
import { useFoodCerts } from "@/hooks/useKhoLots";
import { useHaccp } from "@/hooks/useHaccp";
import { useTraceCandidates } from "@/hooks/useKhoTrace";
import { HACCP_SECTIONS, haccpProgress } from "@/lib/haccp-schema";
import { expiryTone, todayIso } from "@/lib/kho-lots";
import { cn } from "@/lib/utils";

export type TraceTab = "overview" | "papers" | "haccp" | "trace";

interface Task {
  id: string;
  tone: "bad" | "warn" | "plain";
  icon: typeof AlertTriangle;
  title: string;
  sub: string;
  tab: TraceTab;
}

function minusDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/**
 * Truy xuất nguồn gốc → Tổng quan (owner 28/11): how far the HACCP file is, which
 * papers block it, and whether recent production can be traced. Every line opens the
 * tab where the work is done; nothing is edited here.
 */
export function TraceOverview({ onOpen }: { onOpen: (tab: TraceTab) => void }) {
  const today = todayIso();
  const certs = useFoodCerts();
  const checklist = useAttpChecklist(180);
  const haccp = useHaccp({ mode: "manage" });
  const orders = useTraceCandidates(minusDays(today, 14), today);

  const rows = certs.data ?? [];
  const expired = rows.filter((c) => expiryTone(c.days_left) === "expired").length;
  const soon = rows.filter((c) => expiryTone(c.days_left) === "soon").length;
  const pending = rows.filter((c) => c.review_status === "pending").length;

  const totals = checklist.data?.totals;
  const sections = haccp.ready
    ? HACCP_SECTIONS.map((s) => ({ s, p: haccpProgress(s, haccp.store.data, haccp.store.layoutFiles) }))
    : [];
  const haccpPct = sections.length ? Math.floor(sections.reduce((n, x) => n + x.p.pct, 0) / sections.length) : null;
  const haccpDone = sections.filter((x) => x.p.state === "done").length;
  const haccpGaps = sections.filter((x) => x.p.state !== "done").map((x) => x.s.short);

  const list = orders.data ?? [];
  const noIssue = list.filter((o) => !o.has_issue).length;

  const tasks: Task[] = [];
  if (expired) tasks.push({ id: "expired", tone: "bad", icon: FileWarning, title: `${expired} giấy ATTP đã hết hạn`, sub: "Tải giấy mới thay thế để hồ sơ và báo cáo truy xuất còn hiệu lực.", tab: "papers" });
  if (pending) tasks.push({ id: "pending", tone: "warn", icon: Hourglass, title: `${pending} giấy chờ kiểm tra`, sub: "Máy đã đọc xong, cần người xác nhận đúng nhà cung cấp và hạn.", tab: "papers" });
  if (soon) tasks.push({ id: "soon", tone: "warn", icon: Clock, title: `${soon} giấy sắp hết hạn`, sub: "Xin nhà cung cấp giấy mới trước ngày hết hạn.", tab: "papers" });
  if (totals && totals.miss > 0) tasks.push({ id: "miss", tone: "plain", icon: ShieldCheck, title: `Còn thiếu ${totals.miss} giấy ATTP`, sub: "Giấy của nhà cung cấp và nguyên liệu nhập trong 6 tháng.", tab: "papers" });
  if (haccpGaps.length) tasks.push({ id: "haccp", tone: "plain", icon: ClipboardList, title: `Hồ sơ HACCP còn ${haccpGaps.length} mục chưa đủ`, sub: haccpGaps.join(", "), tab: "haccp" });
  if (noIssue) tasks.push({ id: "trace", tone: "warn", icon: Workflow, title: `${noIssue}/${list.length} lệnh sản xuất chưa có phiếu xuất NVL`, sub: "Báo cáo truy xuất của các lệnh này sẽ không liệt kê được nguyên liệu.", tab: "trace" });

  const loading = certs.isLoading || checklist.isLoading || orders.isLoading || (haccp.isLoading && !haccp.ready);
  const ready = !loading && haccpPct === 100 && totals?.pct === 100;

  return (
    <div className="d3-tx" data-bmq-tx-overview>
      <ol className="d3-tx-stages" aria-label="Hành trình">
        <li className={cn(!ready && "is-on", ready && "is-done")}><span>{ready ? <Check aria-hidden="true" /> : 1}</span><b>Chuẩn bị hồ sơ HACCP</b></li>
        <li className={cn(ready && "is-on")}><span>2</span><b>Nộp và đánh giá</b></li>
        <li><span>3</span><b>Duy trì, truy xuất hằng ngày</b></li>
      </ol>

      <div className="d3-tx-metrics">
        <button type="button" className="d3-tx-metric" onClick={() => onOpen("haccp")} data-bmq-tx-metric="haccp">
          <span>Hồ sơ HACCP</span>
          <strong>{haccpPct ?? "–"}<small>%</small></strong>
          <i className="d3-tx-bar" aria-hidden="true"><i style={{ width: `${haccpPct ?? 0}%` }} /></i>
          <small>{haccp.ready ? `${haccpDone}/7 mục đã đủ` : haccp.error ? "Cần quyền sửa Kho để xem" : "Đang đọc…"}</small>
        </button>
        <button type="button" className="d3-tx-metric" onClick={() => onOpen("papers")} data-bmq-tx-metric="papers">
          <span>Giấy tờ ATTP</span>
          <strong>{totals ? totals.pct : "–"}<small>%</small></strong>
          <i className="d3-tx-bar" aria-hidden="true"><i style={{ width: `${totals?.pct ?? 0}%` }} /></i>
          <small>{totals ? `${totals.done}/${totals.total} giấy${expired ? ` · ${expired} hết hạn` : ""}` : checklist.isError ? "Chưa đọc được" : "Đang đọc…"}</small>
        </button>
        <button type="button" className="d3-tx-metric" onClick={() => onOpen("trace")} data-bmq-tx-metric="trace">
          <span>Truy xuất 14 ngày</span>
          <strong>{orders.data ? list.length - noIssue : "–"}<small>/{orders.data ? list.length : "–"}</small></strong>
          <i className="d3-tx-bar" aria-hidden="true"><i style={{ width: `${list.length ? ((list.length - noIssue) * 100) / list.length : 0}%` }} /></i>
          <small>{orders.data ? "lệnh sản xuất truy xuất được nguyên liệu" : orders.isError ? "Chưa đọc được" : "Đang đọc…"}</small>
        </button>
      </div>

      <section className="d3-wh-card d3-tx-tasks" data-bmq-tx-tasks>
        <div className="d3-wh-card-h"><h2>Việc cần làm</h2>{tasks.length ? <small>{tasks.length} việc</small> : null}</div>
        {loading ? <p className="d3-kho-quiet">Đang kiểm tra hồ sơ…</p> : tasks.length ? (
          <ul>
            {tasks.map((t) => (
              <li key={t.id}>
                <button type="button" className={cn("d3-tx-task", `is-${t.tone}`)} onClick={() => onOpen(t.tab)} data-bmq-tx-task={t.id}>
                  <span className="d3-tx-task-ico" aria-hidden="true"><t.icon /></span>
                  <span className="d3-tx-task-text"><b>{t.title}</b><small>{t.sub}</small></span>
                  <ChevronRight className="d3-tx-task-go" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="d3-tx-clear"><Check aria-hidden="true" />Không còn việc nào. Hồ sơ và giấy tờ đang đủ.</p>}
      </section>

      <section className="d3-wh-card d3-tx-routine">
        <div className="d3-wh-card-h"><h2>Giữ truy xuất luôn đủ</h2><p>Ba việc hằng ngày để báo cáo truy xuất có đủ lô, hạn dùng và nhà cung cấp.</p></div>
        <ol>
          <li><PackageCheck aria-hidden="true" /><span><b>Nhập kho</b><small>Ghi NSX, HSD, số lô ở mục “Lô & hạn” của phiếu nhập (chụp nhãn để máy đọc).</small></span><Link to="/goods-receipts">Phiếu nhập kho</Link></li>
          <li><Workflow aria-hidden="true" /><span><b>Sản xuất</b><small>Mỗi lệnh sản xuất có phiếu xuất nguyên liệu.</small></span><Link to="/production/planning/q7">Xưởng Q7</Link></li>
          <li><FileSearch aria-hidden="true" /><span><b>Giấy tờ</b><small>Giấy hết hạn thì tải giấy mới; app nhắc qua Zalo trước 30 và 7 ngày.</small></span><button type="button" onClick={() => onOpen("papers")}>Giấy tờ</button></li>
        </ol>
      </section>
    </div>
  );
}
