import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useRobotAutoActions, useRobotSettings, useSetRobotSettings, useUndoRobotAutoAction } from "@/hooks/useRobotActions";
import { isUndoableRobotAutoAction, robotActionsErrorText, robotAutoActionLabel, type RobotAutoAction } from "@/lib/robot-actions";

const pct = (value: number | null) => (value == null ? "—" : `${Math.round(value * 100)}%`);
const hhmm = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
};

/** How many human corrections Bé Mì keeps in memory (robot_feedback). */
function useLearnedCount() {
  return useQuery({
    queryKey: ["robot-feedback-count"],
    staleTime: 60 * 1000,
    queryFn: async () => {
      const db = supabase as unknown as {
        from: (t: string) => { select: (c: string, o: { count: "exact"; head: true }) => Promise<{ count: number | null; error: unknown }> };
      };
      const { count, error } = await db.from("robot_feedback").select("id", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });
}

function ActionRow({ action, canEdit }: { action: RobotAutoAction; canEdit: boolean }) {
  const { toast } = useToast();
  const undo = useUndoRobotAutoAction();
  const live = isUndoableRobotAutoAction(action);
  return (
    <li className={`robot-auto-row${live ? "" : " is-undone"}`} data-bmq-robot-auto={action.id}>
      <span className="robot-auto-kind">{action.kind === "catalog_class" ? "🏷️ Xếp nhóm" : "🔗 Gắn tên"}</span>
      <b>{robotAutoActionLabel(action)}</b>
      <small>{pct(action.robot_probability)} · {hhmm(action.applied_at)}{live ? "" : " · đã hoàn tác"}</small>
      {live && canEdit ? (
        <button
          type="button"
          className="kg-mini"
          disabled={undo.isPending}
          onClick={() => undo.mutate(action.id, {
            onSuccess: () => toast({ title: "Đã hoàn tác", description: "Bé Mì ghi nhớ và sẽ không tự làm lại việc này." }),
            onError: (error) => toast({ title: "Chưa hoàn tác được", description: robotActionsErrorText(error), variant: "destructive" }),
          })}
        >
          ↩ Hoàn tác
        </button>
      ) : null}
    </li>
  );
}

/** "Bé Mì tự làm hôm nay": what the robot applied on its own, each with an undo, plus the owner switch. */
export function RobotAutoPanel({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const actions = useRobotAutoActions(1);
  const settings = useRobotSettings();
  const setSettings = useSetRobotSettings();
  const learned = useLearnedCount();
  const s = settings.data;
  const rows = actions.data ?? [];
  const applied = rows.filter(isUndoableRobotAutoAction).length;
  const toggle = () => {
    if (!s) return;
    setSettings.mutate({ autoApplyEnabled: !s.auto_apply_enabled }, {
      onSuccess: (next) => toast({ title: next.auto_apply_enabled ? "Bé Mì được tự làm khi chắc" : "Bé Mì chỉ gợi ý, không tự làm" }),
      onError: (error) => toast({ title: "Chỉ chủ được đổi công tắc này", description: robotActionsErrorText(error), variant: "destructive" }),
    });
  };
  return (
    <section className="robot-auto" data-bmq-robot-auto-panel>
      <header>
        <div>
          <h3>Bé Mì tự làm hôm nay · {applied}</h3>
          <p>
            {s ? (s.auto_apply_enabled
              ? `Tự gắn tên khi chắc từ ${pct(s.alias_threshold)}, tự xếp nhóm từ ${pct(s.class_threshold)}, tối đa ${s.daily_cap} việc/ngày. Gộp mặt hàng và chi tiền vẫn do người duyệt.`
              : "Đang tắt: Bé Mì chỉ gợi ý, mọi việc chờ người duyệt.")
              : "…"}
          </p>
        </div>
        {canEdit && s ? (
          <button type="button" className={`robot-auto-switch${s.auto_apply_enabled ? " is-on" : ""}`} disabled={setSettings.isPending} onClick={toggle} aria-pressed={s.auto_apply_enabled}>
            {s.auto_apply_enabled ? "Đang bật" : "Đang tắt"}
          </button>
        ) : null}
      </header>
      <div className="robot-auto-learned" data-bmq-robot-learned>🧠 Đã học {learned.data ?? "…"} lần người duyệt sửa · gợi ý bị bác sẽ không quay lại</div>
      {actions.isLoading ? <p className="note">Đang tải…</p>
        : actions.error ? <p className="note">Chưa đọc được nhật ký: {robotActionsErrorText(actions.error)}</p>
        : rows.length === 0 ? <p className="note">Hôm nay Bé Mì chưa tự làm việc nào.</p>
        : <ul>{rows.map((action) => <ActionRow key={action.id} action={action} canEdit={canEdit} />)}</ul>}
    </section>
  );
}
