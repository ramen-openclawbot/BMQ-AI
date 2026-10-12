/* Phiếu chi lương on the Duyệt chi page. Reads salary_payouts under its own RLS (owner / quyền
 * Chi lương), so other users get no rows and the block stays hidden. Open phiếu first; "Xem tất cả"
 * adds completed and cancelled ones.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, HandCoins, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import "@/styles/bmq-urgent-payables.css";

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Chờ CEO chuyển tiền", tone: "is-amber" },
  advanced: { label: "Chờ bank slip", tone: "is-blue" },
  completed: { label: "Đã chi xong", tone: "is-green" },
  cancelled: { label: "Đã huỷ", tone: "" },
};
const vnd = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;
const dmy = (iso: string) => new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(iso));

interface Row {
  id: string;
  payout_number: string;
  period_name: string;
  source: string;
  employee_count: number;
  total_amount: number;
  status: string;
  created_at: string;
}

export function SalaryPayoutList() {
  const [all, setAll] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["salary-payout", "list", all],
    staleTime: 30_000,
    queryFn: async () => {
      let q = supabase
        .from("salary_payouts")
        .select("id,payout_number,period_name,source,employee_count,total_amount,status,created_at")
        .order("created_at", { ascending: false })
        .limit(all ? 50 : 10);
      if (!all) q = q.in("status", ["pending", "advanced"]);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
  const rows = data ?? [];
  if (!isLoading && !error && rows.length === 0 && !all) return null;

  return (
    <section className="d3-sal-list" aria-label="Phiếu chi lương" data-bmq-salary-list>
      <div className="d3-cs-head">
        <h3><HandCoins className="h-4 w-4" /> Chi lương{rows.length ? ` · ${rows.length}` : ""}</h3>
        <button type="button" className="d3-sal-list-toggle" onClick={() => setAll((v) => !v)} data-bmq-salary-list-all>
          {all ? "Chỉ phiếu đang chờ" : "Xem tất cả"}
        </button>
      </div>
      {isLoading ? (
        <p className="d3-unc-ev-note"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải phiếu lương…</p>
      ) : error ? (
        <p className="d3-unc-ev-note is-bad">Không tải được phiếu lương.</p>
      ) : rows.length === 0 ? (
        <p className="d3-unc-ev-note">Chưa có phiếu chi lương.</p>
      ) : (
        <ul className="d3-sal-list-items">
          {rows.map((r) => {
            const st = STATUS[r.status] ?? { label: r.status, tone: "" };
            return (
              <li key={r.id} data-bmq-salary-list-item={r.status}>
                <Link to={`/salary-payouts/${r.id}`} className="d3-sal-list-row">
                  <span className="d3-sal-list-main">
                    <b>{r.payout_number}</b>
                    <small>{r.source === "manual" ? "Lương lẻ" : "Lương Q7"} · {r.period_name} · {r.employee_count} người · {dmy(r.created_at)}</small>
                  </span>
                  <span className="d3-sal-list-side">
                    <span className="d3-cs-amt">{vnd(r.total_amount)}</span>
                    <span className={cn("d3-up-chip", st.tone)}>{st.label}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 d3-sal-list-arrow" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
