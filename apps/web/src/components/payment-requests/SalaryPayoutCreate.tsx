/* Chi lương (inside Chi tiền mặt): pick a payroll Q7 period with published payslips and create
 * the private salary payout. Only owner / quyền Chi lương see this; the Zalo notice has no amount.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banknote, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useSalaryPayout } from "@/hooks/useSalaryPayout";
import "@/styles/bmq-pr-create.css";

const ERROR_TEXT: Record<string, string> = {
  payout_already_exists: "Kỳ lương này đã có phiếu chi lương.",
  no_published_payslips: "Kỳ lương này chưa công bố phiếu lương.",
  insufficient_privilege: "Anh/chị chưa có quyền Chi lương.",
};

export function SalaryPayoutCreate({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { periods, isLoadingPeriods, periodsError, create } = useSalaryPayout(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const published = periods.filter((p) => p.published_at);

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      const result = await create(picked);
      toast.success(`Đã tạo ${result.payout_number}. Nhóm Zalo đã được báo (không kèm số tiền).`);
      onDone();
      navigate(`/salary-payouts/${result.payout_id}`);
    } catch (err) {
      const message = String((err as { message?: unknown })?.message ?? err ?? "");
      const code = Object.keys(ERROR_TEXT).find((k) => message.includes(k));
      toast.error(code ? ERROR_TEXT[code] : message || "Chưa tạo được phiếu chi lương.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="d3-cs" aria-label="Chi lương" data-bmq-salary-create>
      <div className="d3-cs-head"><h3>Kỳ lương Q7 đã công bố</h3></div>
      {isLoadingPeriods ? (
        <p className="d3-unc-ev-note"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải kỳ lương…</p>
      ) : periodsError ? (
        <p className="d3-unc-ev-note is-bad"><TriangleAlert className="h-4 w-4" /> Không tải được bảng lương.</p>
      ) : published.length === 0 ? (
        <p className="d3-unc-ev-note">Chưa có kỳ lương nào công bố phiếu lương.</p>
      ) : (
        <ul className="d3-cpr-periods">
          {published.map((p) => (
            <li key={p.period_id}>
              <button type="button" className={picked === p.period_id ? "is-on" : undefined} onClick={() => setPicked(p.period_id)} aria-pressed={picked === p.period_id} data-bmq-salary-period={p.period_id}>
                <b>{p.period_name}</b>
                <small>Lấy lương thực nhận từ bảng lương</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="d3-prc-hint">Tin Zalo chỉ có mã phiếu, kỳ lương và số nhân viên. Số tiền chỉ xem được trong app với quyền Chi lương.</p>
      <div className="d3-ub-foot">
        <p>{picked ? "1 kỳ lương" : "Chọn kỳ lương"}</p>
        <Button className="d3-ub-go" disabled={!picked || saving} onClick={() => void save()} data-bmq-salary-create-save>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
          Tạo phiếu chi lương
        </Button>
      </div>
    </section>
  );
}
