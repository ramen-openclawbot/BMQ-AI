/* Chi lương (inside Chi tiền mặt): either pick a payroll Q7 period with published payslips, or
 * type a Lương lẻ list (BMQ staff outside bếp Q7). Both create the same private salary payout;
 * only owner / quyền Chi lương see this and the Zalo notice has no amount.
 */
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Banknote, Loader2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSalaryPayout } from "@/hooks/useSalaryPayout";
import { validateManualSalaryPayout } from "@/lib/salary-manual-lines";
import "@/styles/bmq-pr-create.css";

const ERROR_TEXT: Record<string, string> = {
  payout_already_exists: "Kỳ lương này đã có phiếu chi lương.",
  no_published_payslips: "Kỳ lương này chưa công bố phiếu lương.",
  insufficient_privilege: "Anh/chị chưa có quyền Chi lương.",
  duplicate_employee_code: "Có mã nhân viên bị trùng.",
  total_exceeds_limit: "Tổng tiền vượt hạn mức.",
};
const errorText = (err: unknown, fallback: string) => {
  const message = String((err as { message?: unknown })?.message ?? err ?? "");
  const code = Object.keys(ERROR_TEXT).find((k) => message.includes(k));
  return code ? ERROR_TEXT[code] : message || fallback;
};
const vnd = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;
const monthTitle = () => {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()); // YYYY-MM-DD
  return `Lương lẻ T${d.slice(5, 7)}/${d.slice(0, 4)}`;
};

interface Row {
  key: string;
  name: string;
  amount: string;
  note: string;
}
let seq = 0;
const newRow = (): Row => ({ key: `r${(seq += 1)}`, name: "", amount: "", note: "" });

export function SalaryPayoutCreate({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const { periods, isLoadingPeriods, periodsError, create, createManual } = useSalaryPayout(null);
  const [kind, setKind] = useState<"q7" | "manual">("q7");
  const [picked, setPicked] = useState<string | null>(null);
  const [title, setTitle] = useState(monthTitle);
  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const sessionRef = useRef(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const published = periods.filter((p) => p.published_at);

  const lines = useMemo(
    () =>
      rows
        .filter((r) => r.name.trim() || r.amount)
        .map((r) => ({ employee_name: r.name.trim(), amount: Number(r.amount || 0), note: r.note.trim() || null })),
    [rows],
  );
  const total = lines.reduce((s, l) => s + (Number.isFinite(l.amount) ? l.amount : 0), 0);
  const setRow = (key: string, patch: Partial<Row>) => {
    setErrors([]);
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const finish = (payoutId: string, number: string) => {
    toast.success(`Đã tạo ${number}. Nhóm Zalo đã được báo (không kèm số tiền).`);
    onDone();
    navigate(`/salary-payouts/${payoutId}`);
  };

  const saveQ7 = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      const result = await create(picked);
      finish(result.payout_id, result.payout_number);
    } catch (err) {
      toast.error(errorText(err, "Chưa tạo được phiếu chi lương."));
    } finally {
      setSaving(false);
    }
  };

  const saveManual = async () => {
    const check = validateManualSalaryPayout({ title, lines });
    if (!check.valid) {
      setErrors(check.errors.map((e) => e.message));
      toast.error(check.errors[0].message);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const result = await createManual({ title: title.trim(), lines }, { sessionId: sessionRef.current });
      finish(result.payout_id, result.payout_number);
    } catch (err) {
      const message = errorText(err, "Chưa tạo được phiếu lương lẻ.");
      setErrors([message]);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="d3-cs" aria-label="Chi lương" data-bmq-salary-create>
      <div className="d3-cpr-modes" role="tablist" aria-label="Loại chi lương">
        <button type="button" role="tab" aria-selected={kind === "q7"} className={kind === "q7" ? "is-on" : undefined} onClick={() => setKind("q7")} disabled={saving} data-bmq-salary-kind="q7">
          Lương bếp Q7
        </button>
        <button type="button" role="tab" aria-selected={kind === "manual"} className={kind === "manual" ? "is-on" : undefined} onClick={() => setKind("manual")} disabled={saving} data-bmq-salary-kind="manual">
          Lương lẻ
        </button>
      </div>

      {kind === "q7" ? (
        <>
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
        </>
      ) : (
        <>
          <label className="d3-cc-f">
            <span className="d3-unc-label">Tiêu đề phiếu</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} data-bmq-salary-manual-title />
          </label>
          <div className="d3-cs-head"><h3>Nhân viên ngoài bếp Q7</h3></div>
          <ul className="d3-cpr-lines">
            {rows.map((r, idx) => (
              <li key={r.key} data-bmq-salary-manual-row={idx}>
                <div className="d3-cpr-line-top">
                  <span className="d3-cpr-tag">Người {idx + 1}</span>
                  <button type="button" className="d3-cs-x" aria-label="Bỏ dòng" onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((x) => x.key !== r.key) : [newRow()]))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <Input value={r.name} onChange={(e) => setRow(r.key, { name: e.target.value })} placeholder="Họ tên nhân viên" maxLength={120} aria-label="Họ tên nhân viên" data-bmq-salary-manual-name />
                <div className="d3-cpr-line-row">
                  <Input
                    inputMode="numeric"
                    value={r.amount ? new Intl.NumberFormat("vi-VN").format(Number(r.amount)) : ""}
                    onChange={(e) => setRow(r.key, { amount: e.target.value.replace(/[^\d]/g, "") })}
                    placeholder="Số tiền"
                    aria-label="Số tiền"
                    data-bmq-salary-manual-amount
                  />
                  <Input value={r.note} onChange={(e) => setRow(r.key, { note: e.target.value })} placeholder="Ghi chú" maxLength={200} aria-label="Ghi chú" />
                </div>
              </li>
            ))}
          </ul>
          <Button type="button" variant="outline" className="h-11 w-full gap-2" onClick={() => setRows((prev) => [...prev, newRow()].slice(0, 50))} data-bmq-salary-manual-add>
            <Plus className="h-4 w-4" /> Thêm nhân viên
          </Button>
          {errors.length > 0 && (
            <p className="d3-ub-why is-bad" role="alert"><TriangleAlert className="h-3.5 w-3.5" /> {errors.join(" ")}</p>
          )}
        </>
      )}

      <p className="d3-prc-hint">Tin Zalo chỉ có mã phiếu, tên kỳ lương và số nhân viên. Số tiền chỉ xem được trong app với quyền Chi lương.</p>
      <div className="d3-ub-foot">
        {kind === "q7" ? (
          <>
            <p>{picked ? "1 kỳ lương" : "Chọn kỳ lương"}</p>
            <Button className="d3-ub-go" disabled={!picked || saving} onClick={() => void saveQ7()} data-bmq-salary-create-save>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
              Tạo phiếu chi lương
            </Button>
          </>
        ) : (
          <>
            <p>
              <b>{lines.length}</b> người · <b>{vnd(total)}</b>
            </p>
            <Button className="d3-ub-go" disabled={saving || lines.length === 0} onClick={() => void saveManual()} data-bmq-salary-manual-save>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
              Tạo phiếu lương lẻ
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
