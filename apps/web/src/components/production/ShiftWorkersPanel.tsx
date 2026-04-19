import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, UserPlus, X, Users } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";

interface ShiftWorker {
  id: string;
  shift_id: string;
  employee_code: string;
  employee_name: string | null;
  role: string | null;
  minutes_worked: number | null;
  notes: string | null;
}

interface Props {
  shiftId: string;
  shiftDate: string;
  disabled?: boolean;
}

export function ShiftWorkersPanel({ shiftId, shiftDate, disabled }: Props) {
  const { language } = useLanguage();
  const { canEditModule } = useAuth();
  const isVi = language === "vi";
  const canEdit = !disabled && canEditModule("production");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [empCode, setEmpCode] = useState("");
  const [empName, setEmpName] = useState("");
  const [role, setRole] = useState("");
  const [minutes, setMinutes] = useState("");

  const copy = {
    title: isVi ? "Công nhân ca này" : "Workers on this shift",
    subtitle: isVi
      ? "Thêm công nhân để hệ thống phân bổ chi phí lương vào SKU được sản xuất trong ca."
      : "Add workers so labor cost can be attributed to the SKUs produced in this shift.",
    add: isVi ? "Thêm công nhân" : "Add worker",
    code: isVi ? "Mã NV" : "Employee code",
    name: isVi ? "Tên" : "Name",
    role: isVi ? "Vai trò (tuỳ chọn)" : "Role (optional)",
    minutes: isVi ? "Phút làm (tuỳ chọn)" : "Minutes worked (optional)",
    empty: isVi ? "Chưa có công nhân nào." : "No workers yet.",
    remove: isVi ? "Xoá" : "Remove",
    success: isVi ? "Thành công" : "Success",
    errorTitle: isVi ? "Lỗi" : "Error",
    addedDone: isVi ? "Đã thêm công nhân" : "Worker added",
    removedDone: isVi ? "Đã xoá công nhân" : "Worker removed",
    failedAdd: isVi ? "Không thể thêm công nhân" : "Could not add worker",
    failedRemove: isVi ? "Không thể xoá" : "Could not remove",
    codeMissing: isVi ? "Vui lòng nhập mã NV" : "Please enter employee code",
    suggestedLabel: isVi ? "Gợi ý từ chấm công:" : "From attendance:",
    costPreview: isVi ? "Chi phí ước tính" : "Estimated cost",
    noWageProfile: isVi ? "Chưa có hợp đồng lương" : "No wage profile",
  };

  // Workers list
  const { data: workers = [], isLoading } = useQuery<ShiftWorker[]>({
    queryKey: ["production-shift-workers", shiftId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_shift_workers")
        .select("*")
        .eq("shift_id", shiftId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data as ShiftWorker[]) || [];
    },
    enabled: !!shiftId,
  });

  // Cost preview per worker (from v_shift_worker_cost)
  const { data: costRows = [] } = useQuery<
    Array<{ employee_code: string; estimated_cost: number | null; wage_type: string | null }>
  >({
    queryKey: ["shift-worker-cost", shiftId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_shift_worker_cost")
        .select("employee_code, estimated_cost, wage_type")
        .eq("shift_id", shiftId);
      if (error) return [];
      return data || [];
    },
    enabled: !!shiftId,
  });
  const costByEmp = useMemo(() => {
    const m: Record<string, { cost: number | null; wage_type: string | null }> = {};
    for (const r of costRows) {
      m[r.employee_code] = { cost: r.estimated_cost, wage_type: r.wage_type };
    }
    return m;
  }, [costRows]);

  // Autocomplete suggestions — employees who had an attendance assignment within ±7 days
  const { data: suggestions = [] } = useQuery<Array<{ employee_code: string; employee_name: string | null }>>({
    queryKey: ["shift-worker-suggestions", shiftDate],
    queryFn: async () => {
      const from = new Date(shiftDate);
      from.setDate(from.getDate() - 7);
      const to = new Date(shiftDate);
      to.setDate(to.getDate() + 7);
      const { data, error } = await (supabase as any)
        .from("attendance_shift_assignments")
        .select("employee_code, employee_name")
        .gte("work_date", from.toISOString().slice(0, 10))
        .lte("work_date", to.toISOString().slice(0, 10))
        .limit(200);
      if (error) return [];
      const seen = new Set<string>();
      const out: Array<{ employee_code: string; employee_name: string | null }> = [];
      for (const row of data || []) {
        if (!seen.has(row.employee_code)) {
          seen.add(row.employee_code);
          out.push({ employee_code: row.employee_code, employee_name: row.employee_name ?? null });
        }
      }
      return out.slice(0, 30);
    },
    enabled: !!shiftDate,
  });

  const addWorker = useMutation({
    mutationFn: async () => {
      if (!empCode.trim()) throw new Error(copy.codeMissing);
      const payload = {
        shift_id: shiftId,
        employee_code: empCode.trim(),
        employee_name: empName.trim() || null,
        role: role.trim() || null,
        minutes_worked: minutes ? Math.max(0, parseInt(minutes, 10)) : null,
      };
      const { error } = await (supabase as any)
        .from("production_shift_workers")
        .insert(payload);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: copy.success, description: copy.addedDone });
      setEmpCode("");
      setEmpName("");
      setRole("");
      setMinutes("");
      queryClient.invalidateQueries({ queryKey: ["production-shift-workers", shiftId] });
      queryClient.invalidateQueries({ queryKey: ["shift-worker-cost", shiftId] });
    },
    onError: (err) => {
      toast({
        title: copy.errorTitle,
        description: err instanceof Error ? err.message : copy.failedAdd,
        variant: "destructive",
      });
    },
  });

  const removeWorker = useMutation({
    mutationFn: async (workerId: string) => {
      const { error } = await (supabase as any)
        .from("production_shift_workers")
        .delete()
        .eq("id", workerId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: copy.success, description: copy.removedDone });
      queryClient.invalidateQueries({ queryKey: ["production-shift-workers", shiftId] });
      queryClient.invalidateQueries({ queryKey: ["shift-worker-cost", shiftId] });
    },
    onError: (err) => {
      toast({
        title: copy.errorTitle,
        description: err instanceof Error ? err.message : copy.failedRemove,
        variant: "destructive",
      });
    },
  });

  const pickSuggestion = (s: { employee_code: string; employee_name: string | null }) => {
    setEmpCode(s.employee_code);
    if (s.employee_name) setEmpName(s.employee_name);
  };

  const formatMoney = (n: number | null | undefined) => {
    if (n === null || n === undefined) return "—";
    return new Intl.NumberFormat("vi-VN").format(Math.round(n));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <label className="text-sm font-medium">{copy.title}</label>
      </div>
      <p className="text-xs text-muted-foreground">{copy.subtitle}</p>

      {/* Existing workers list */}
      <div className="border rounded text-sm">
        {isLoading ? (
          <div className="p-3 flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : workers.length === 0 ? (
          <div className="p-3 text-muted-foreground">{copy.empty}</div>
        ) : (
          <ul className="divide-y">
            {workers.map((w) => {
              const cost = costByEmp[w.employee_code];
              return (
                <li key={w.id} className="flex items-center gap-3 p-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {w.employee_code}
                      </span>
                      <span className="font-medium truncate">
                        {w.employee_name ?? w.employee_code}
                      </span>
                      {w.role && (
                        <Badge variant="outline" className="text-xs">
                          {w.role}
                        </Badge>
                      )}
                      {w.minutes_worked != null && (
                        <span className="text-xs text-muted-foreground">
                          {w.minutes_worked}′
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {cost?.wage_type ? (
                        <>
                          {copy.costPreview}:&nbsp;
                          <span className="font-semibold text-foreground">
                            {formatMoney(cost.cost)}
                          </span>
                          &nbsp;·&nbsp;{cost.wage_type}
                        </>
                      ) : (
                        <span className="italic">{copy.noWageProfile}</span>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeWorker.mutate(w.id)}
                      disabled={removeWorker.isPending}
                      aria-label={copy.remove}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Add-worker form */}
      {canEdit && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Input
              placeholder={copy.code}
              value={empCode}
              onChange={(e) => setEmpCode(e.target.value)}
            />
            <Input
              placeholder={copy.name}
              value={empName}
              onChange={(e) => setEmpName(e.target.value)}
            />
            <Input
              placeholder={copy.role}
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
            <Input
              placeholder={copy.minutes}
              type="number"
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => addWorker.mutate()}
              disabled={addWorker.isPending || !empCode.trim()}
              size="sm"
            >
              {addWorker.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <UserPlus className="h-4 w-4 mr-1" />
              )}
              {copy.add}
            </Button>
          </div>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              <span className="text-xs text-muted-foreground mr-1">
                {copy.suggestedLabel}
              </span>
              {suggestions.map((s) => (
                <button
                  key={s.employee_code}
                  type="button"
                  onClick={() => pickSuggestion(s)}
                  className="text-xs px-2 py-0.5 rounded-full border hover:bg-accent transition-colors"
                >
                  <span className="font-mono">{s.employee_code}</span>
                  {s.employee_name && <span className="ml-1">{s.employee_name}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ShiftWorkersPanel;
