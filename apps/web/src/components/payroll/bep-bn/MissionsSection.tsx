import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Dices, Gift, Loader2, RefreshCw, Send, Sparkles, Trophy } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { MISSION_TEMPLATE_CODES, MISSION_TEMPLATE_DEFINITIONS } from "@/lib/payroll-missions/templates.ts";
import type { MissionRecord, MissionStatus, MissionTemplateCode, MissionTemplateRecord } from "@/lib/payroll-missions/types.ts";
import type { BepBnDataSource, BepBnPeriodData } from "./types";

// Nhiệm vụ thưởng bất ngờ — manager surface. Every rule (2 people, one mission
// each, draw, budget, locked period) is enforced by the server; this screen only
// collects input and shows the server state.

const vnd = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const money = (value: number) => `${vnd.format(value)} đ`;

const STATUS_LABELS: Record<MissionStatus, string> = {
  suggested: "Gợi ý",
  published: "Đã phát hành",
  accepted: "Đã nhận",
  achieved: "Đạt",
  not_achieved: "Không đạt",
  needs_review: "Cần xem lại",
  expired: "Hết hạn",
  cancelled: "Đã bỏ",
  paid: "Đã cộng lương",
};

const STATUS_VARIANT: Record<MissionStatus, "default" | "secondary" | "outline" | "destructive"> = {
  suggested: "outline",
  published: "secondary",
  accepted: "secondary",
  achieved: "default",
  not_achieved: "destructive",
  needs_review: "outline",
  expired: "outline",
  cancelled: "outline",
  paid: "default",
};

/** Parameters shown per template; values are always entered by the owner. */
const PARAM_FIELDS: Record<MissionTemplateCode, { key: string; label: string; unit: string }[]> = {
  "T-DUNGGIO": [
    { key: "nguong_de_xuat", label: "Gợi ý khi tháng trước trễ từ", unit: "ngày" },
    { key: "dung_sai_phut", label: "Trễ dưới mức này không tính", unit: "phút" },
    { key: "so_ngay_tre_toi_da", label: "Số ngày trễ được phép", unit: "ngày" },
  ],
  "T-CHAMDU": [{ key: "nguong_de_xuat", label: "Gợi ý khi tháng trước thiếu chấm từ", unit: "ngày" }],
  "T-CHUYENCAN": [{ key: "so_ngay_toi_thieu", label: "Số ngày có mặt tối thiểu", unit: "ngày" }],
  "T-GIOPT": [
    { key: "gio_toi_thieu", label: "Giờ tối thiểu", unit: "giờ" },
    { key: "gio_toi_da", label: "Giờ tối đa", unit: "giờ" },
  ],
  "T-QL": [],
};

const PICKED_STATUSES: readonly MissionStatus[] = ["published", "accepted", "achieved", "not_achieved", "needs_review", "paid"];

function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[.\s]/g, "").replace(",", ".").trim();
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Vui lòng thử lại.";
}

interface MissionsSectionProps {
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canEdit: boolean;
}

type ReasonAction = { kind: "redraw" } | { kind: "discard"; mission: MissionRecord };

export function MissionsSection({ data, source, canEdit }: MissionsSectionProps) {
  const { toast } = useToast();
  const state = source.missions;
  const locked = data.period.status === "locked";
  const approved = Boolean(data.attendanceApprovedAt);
  const editable = canEdit && !locked;
  const [busy, setBusy] = useState<string | null>(null);
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null);
  const [confirming, setConfirming] = useState<MissionRecord | null>(null);

  const names = useMemo(() => new Map(data.employees.map((employee) => [employee.code, employee.name])), [data.employees]);
  const nameOf = (code: string) => names.get(code) ?? code;

  const run = async (key: string, action: () => Promise<void>, success: string) => {
    setBusy(key);
    try {
      await action();
      toast({ title: success });
      return true;
    } catch (error) {
      toast({ title: "Không thực hiện được", description: errorText(error), variant: "destructive" });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const suggested = state.missions.filter((mission) => mission.status === "suggested");
  const picked = state.missions.filter((mission) => PICKED_STATUSES.includes(mission.status));
  const drawnIds = new Set((state.latestDraw?.picked ?? []).map((pick) => pick.missionId));
  const drawnWaiting = state.missions.filter((mission) => drawnIds.has(mission.id) && mission.status === "suggested");
  const anyPublished = picked.length > 0;
  const maxEmployees = state.settings?.maxEmployees ?? 2;
  const budget = state.settings?.budgetVnd ?? null;
  const bonusTotal = state.bonuses.reduce((sum, bonus) => sum + bonus.amountVnd, 0);
  const canEvaluate = state.missions.some((mission) => mission.status === "accepted" && mission.verification === "auto");
  const canCreateBonuses = state.missions.some((mission) => mission.status === "achieved");

  if (state.loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Đang tải nhiệm vụ…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {state.error ? (
        <Card className="border-destructive/40">
          <CardContent role="alert" className="py-3 text-sm text-destructive">
            {state.error}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gift className="h-4 w-4 shrink-0 text-primary" />
            Nhiệm vụ thưởng bất ngờ
          </CardTitle>
          <CardDescription>
            {data.period.name}. Mỗi tháng bốc thăm tối đa {maxEmployees} người trong danh sách gợi ý, mỗi người 1 nhiệm vụ. Nhiệm vụ đạt được cộng vào lương
            ngay tháng này, trước khi chốt kỳ.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Metric label="Người được chọn" value={`${new Set(picked.map((mission) => mission.employeeCode)).size} / ${maxEmployees}`} />
          <Metric label="Trần thưởng tháng" value={budget === null ? "Chưa nhập" : money(budget)} warn={budget === null} />
          <Metric label="Đã cộng vào lương" value={money(bonusTotal)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Các bước trong tháng</CardTitle>
          <CardDescription>Làm lần lượt từ trên xuống. Mỗi bước đều được máy chủ kiểm tra lại.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Step
            index={1}
            title="Gợi ý từ chấm công tháng trước"
            detail={suggested.length > 0 ? `${suggested.length} nhiệm vụ gợi ý cho ${new Set(suggested.map((m) => m.employeeCode)).size} người` : "Chưa có gợi ý"}
          >
            <Button
              variant="outline"
              className="gap-2"
              disabled={!editable || busy !== null || anyPublished}
              onClick={() => void run("suggest", () => source.suggestFromPrevious(), "Đã tạo danh sách gợi ý")}
            >
              {busy === "suggest" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Tạo gợi ý
            </Button>
          </Step>

          <Step
            index={2}
            title="Bốc thăm"
            detail={
              state.latestDraw
                ? `Lần bốc ${state.latestDraw.drawNo}: ${state.latestDraw.picked.length} người trúng trong ${state.latestDraw.pool.length} người dự bốc${state.latestDraw.reason ? ` · Lý do: ${state.latestDraw.reason}` : ""}`
                : "Chưa bốc thăm"
            }
          >
            {state.latestDraw ? (
              <Button
                variant="outline"
                className="gap-2"
                disabled={!editable || busy !== null || anyPublished}
                onClick={() => setReasonAction({ kind: "redraw" })}
              >
                <RefreshCw className="h-4 w-4" />
                Bốc lại
              </Button>
            ) : (
              <Button
                className="gap-2"
                disabled={!editable || busy !== null || suggested.length === 0}
                onClick={() => void run("draw", () => source.draw(), "Đã bốc thăm")}
              >
                {busy === "draw" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Dices className="h-4 w-4" />}
                Bốc thăm
              </Button>
            )}
          </Step>

          {drawnWaiting.length > 0 ? (
            <Step index={3} title="Phát hành cho người trúng" detail="Chỉ người trúng mới thấy nhiệm vụ của mình.">
              <div className="flex w-full flex-col gap-2 sm:w-auto">
                {drawnWaiting.map((mission) => (
                  <Button
                    key={mission.id}
                    variant="outline"
                    className="h-auto justify-start gap-2 whitespace-normal py-2 text-left"
                    disabled={!editable || busy !== null}
                    onClick={() => void run(`publish-${mission.id}`, () => source.publish(mission.id), "Đã phát hành nhiệm vụ")}
                  >
                    {busy === `publish-${mission.id}` ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Send className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0">
                      Phát hành · {nameOf(mission.employeeCode)} — {mission.templateName}
                    </span>
                  </Button>
                ))}
              </div>
            </Step>
          ) : (
            <Step index={3} title="Phát hành cho người trúng" detail={anyPublished ? "Đã phát hành" : "Sau khi bốc thăm"} />
          )}

          <Step
            index={4}
            title="Chấm kết quả"
            detail={
              locked
                ? "Kỳ đã chốt"
                : approved
                  ? "Chấm các nhiệm vụ tự động đã nhận từ chấm công tháng này"
                  : "Chờ duyệt chấm công tháng này"
            }
          >
            <Button
              variant="outline"
              className="gap-2"
              disabled={!editable || busy !== null || !approved || !canEvaluate}
              onClick={() => void run("evaluate", () => source.evaluateAccepted(), "Đã chấm kết quả")}
            >
              {busy === "evaluate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trophy className="h-4 w-4" />}
              Chấm kết quả
            </Button>
          </Step>

          <Step index={5} title="Cộng thưởng vào bảng lương" detail="Chỉ nhiệm vụ đạt có mức thưởng, trong trần của tháng.">
            <Button
              className="gap-2"
              disabled={!editable || busy !== null || !canCreateBonuses}
              onClick={() => void run("bonuses", () => source.createBonuses(), "Đã cộng thưởng vào bảng lương")}
            >
              {busy === "bonuses" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gift className="h-4 w-4" />}
              Cộng thưởng
            </Button>
          </Step>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Nhiệm vụ của tháng</CardTitle>
        </CardHeader>
        <CardContent>
          {state.missions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Chưa có nhiệm vụ. Bắt đầu từ bước 1.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {state.missions.map((mission) => {
                const reviewable =
                  editable &&
                  (mission.status === "needs_review" || (mission.status === "accepted" && mission.verification === "manager"));
                return (
                  <li key={mission.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{nameOf(mission.employeeCode)}</span>
                        <span className="text-xs text-muted-foreground">{mission.employeeCode}</span>
                        <Badge variant={STATUS_VARIANT[mission.status]}>{STATUS_LABELS[mission.status]}</Badge>
                        {drawnIds.has(mission.id) ? <Badge variant="secondary">Trúng thăm</Badge> : null}
                      </div>
                      <p className="text-sm">
                        {mission.templateName}
                        {mission.rewardVnd !== null && mission.mode === "pay" ? ` · ${money(mission.rewardVnd)}` : null}
                        {mission.mode === "reconcile_only" ? " · chỉ đối chiếu" : null}
                      </p>
                      {mission.reasonText ? <p className="break-words text-xs text-muted-foreground">Lý do gợi ý: {mission.reasonText}</p> : null}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {reviewable ? (
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirming(mission)}>
                          Xác nhận kết quả
                        </Button>
                      ) : null}
                      {editable && mission.status === "suggested" ? (
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setReasonAction({ kind: "discard", mission })}>
                          Bỏ
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <SettingsCard
        key={`${data.id}-${maxEmployees}-${budget ?? "none"}`}
        maxEmployees={maxEmployees}
        budget={budget}
        disabled={!editable || busy !== null}
        saving={busy === "settings"}
        onSave={(settings) => run("settings", () => source.saveSettings(settings), "Đã lưu cài đặt tháng")}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Mẫu nhiệm vụ tháng này</CardTitle>
          <CardDescription>Mức thưởng và ngưỡng do chủ dự án nhập. Mẫu chưa có mức thưởng thì không cộng tiền.</CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion type="multiple" className="rounded-md border">
          {MISSION_TEMPLATE_CODES.filter((code) => code !== "T-QL").map((code) => (
            <TemplateCard
              key={`${data.id}-${code}-${state.templates.find((item) => item.code === code)?.id ?? "new"}`}
              code={code}
              record={state.templates.find((item) => item.code === code) ?? null}
              disabled={!editable || busy !== null}
              saving={busy === `template-${code}`}
              onSave={(input) => run(`template-${code}`, () => source.saveTemplate(input), "Đã lưu mẫu nhiệm vụ")}
            />
          ))}
          </Accordion>
        </CardContent>
      </Card>

      <ReasonDialog
        action={reasonAction}
        busy={busy !== null}
        onClose={() => setReasonAction(null)}
        onConfirm={async (reason) => {
          if (!reasonAction) return;
          const ok =
            reasonAction.kind === "redraw"
              ? await run("draw", () => source.draw(reason), "Đã bốc thăm lại")
              : await run("discard", () => source.discard(reasonAction.mission.id, reason), "Đã bỏ nhiệm vụ");
          if (ok) setReasonAction(null);
        }}
      />

      <ConfirmResultDialog
        mission={confirming}
        employeeName={confirming ? nameOf(confirming.employeeCode) : ""}
        busy={busy !== null}
        onClose={() => setConfirming(null)}
        onConfirm={async (status, reason) => {
          if (!confirming) return;
          const ok = await run(
            "confirm",
            () => source.managerConfirm(confirming.id, { status, evidence: { confirmed_by: "manager" } }, reason),
            "Đã xác nhận kết quả",
          );
          if (ok) setConfirming(null);
        }}
      />
    </div>
  );
}

function Metric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", warn && "text-destructive")}>{value}</p>
    </div>
  );
}

function Step({ index, title, detail, children }: { index: number; title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">{index}</span>
        <div className="min-w-0">
          <p className="font-medium">{title}</p>
          <p className="break-words text-sm text-muted-foreground">{detail}</p>
        </div>
      </div>
      {children ? <div className="flex shrink-0 sm:justify-end">{children}</div> : null}
    </div>
  );
}

function SettingsCard({
  maxEmployees,
  budget,
  disabled,
  saving,
  onSave,
}: {
  maxEmployees: number;
  budget: number | null;
  disabled: boolean;
  saving: boolean;
  onSave: (settings: { maxEmployees: number; budgetVnd: number | null }) => Promise<boolean>;
}) {
  const [max, setMax] = useState(String(maxEmployees));
  const [cap, setCap] = useState(budget === null ? "" : String(budget));
  const maxValue = parseNumber(max);
  const capValue = parseNumber(cap);
  const invalid = maxValue === null || !Number.isInteger(maxValue) || (cap.trim() !== "" && capValue === null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Cài đặt tháng</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="missions-max">Số người mỗi tháng</Label>
          <Input id="missions-max" inputMode="numeric" value={max} onChange={(event) => setMax(event.target.value)} disabled={disabled} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="missions-budget">Trần thưởng tháng (đồng)</Label>
          <Input
            id="missions-budget"
            inputMode="numeric"
            placeholder="Chưa nhập"
            value={cap}
            onChange={(event) => setCap(event.target.value)}
            disabled={disabled}
          />
        </div>
        <Button
          variant="outline"
          disabled={disabled || invalid}
          onClick={() => void onSave({ maxEmployees: maxValue ?? 0, budgetVnd: cap.trim() === "" ? null : capValue })}
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Lưu
        </Button>
        {budget === null ? (
          <p className="text-sm text-destructive sm:col-span-3">Chưa nhập trần thưởng: nhiệm vụ đạt sẽ không được cộng tiền.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TemplateCard({
  code,
  record,
  disabled,
  saving,
  onSave,
}: {
  code: MissionTemplateCode;
  record: MissionTemplateRecord | null;
  disabled: boolean;
  saving: boolean;
  onSave: (input: Parameters<BepBnDataSource["saveTemplate"]>[0]) => Promise<boolean>;
}) {
  const definition = MISSION_TEMPLATE_DEFINITIONS[code];
  const pays = definition.mode === "pay";
  const fields = PARAM_FIELDS[code];
  const [enabled, setEnabled] = useState(record?.enabled ?? false);
  const [reward, setReward] = useState(record?.rewardVnd === null || record?.rewardVnd === undefined ? "" : String(record.rewardVnd));
  const [deadline, setDeadline] = useState(record?.acceptDeadline ?? "");
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, record?.params[field.key] === undefined ? "" : String(record.params[field.key])])),
  );

  useEffect(() => {
    setEnabled(record?.enabled ?? false);
  }, [record?.enabled]);

  const rewardValue = parseNumber(reward);
  const paramValues = Object.fromEntries(
    Object.entries(params)
      .map(([key, text]) => [key, parseNumber(text)] as const)
      .filter(([, value]) => value !== null),
  );
  const missingRequired = enabled && definition.requiredParams.some((key) => paramValues[key] === undefined);
  const invalid = (reward.trim() !== "" && rewardValue === null) || missingRequired;

  const summary = !record
    ? "Chưa cài đặt"
    : !record.enabled
      ? "Đang tắt"
      : pays
        ? record.rewardVnd === null
          ? "Bật · chưa nhập mức thưởng"
          : `Bật · ${money(record.rewardVnd)}`
        : "Bật · chỉ đối chiếu";

  return (
    <AccordionItem value={code} className="px-3 last:border-b-0">
      <AccordionTrigger className="gap-3 py-3 text-left hover:no-underline">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{definition.name}</p>
          <p className={cn("text-xs font-normal", record?.enabled ? "text-muted-foreground" : "text-muted-foreground/80")}>{summary}</p>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-3 pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <Badge variant="outline">{definition.verification === "auto" ? "Tự chấm từ chấm công" : "Quản lý xác nhận"}</Badge>
          <Badge variant={pays ? "secondary" : "outline"}>{pays ? "Có thưởng" : "Chỉ đối chiếu"}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Label htmlFor={`tpl-on-${code}`} className="text-xs text-muted-foreground">
            Bật
          </Label>
          <Switch id={`tpl-on-${code}`} checked={enabled} onCheckedChange={setEnabled} disabled={disabled} />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{definition.description}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {pays ? (
          <div className="space-y-1">
            <Label htmlFor={`tpl-reward-${code}`} className="text-xs">
              Mức thưởng (đồng)
            </Label>
            <Input
              id={`tpl-reward-${code}`}
              inputMode="numeric"
              placeholder="Chưa nhập"
              value={reward}
              onChange={(event) => setReward(event.target.value)}
              disabled={disabled}
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={`tpl-deadline-${code}`} className="text-xs">
            Hạn nhận nhiệm vụ
          </Label>
          <Input
            id={`tpl-deadline-${code}`}
            type="date"
            value={deadline}
            onChange={(event) => setDeadline(event.target.value)}
            disabled={disabled}
          />
        </div>
        {fields.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`tpl-${code}-${field.key}`} className="text-xs">
              {field.label} ({field.unit})
            </Label>
            <Input
              id={`tpl-${code}-${field.key}`}
              inputMode="decimal"
              placeholder="Chưa nhập"
              value={params[field.key] ?? ""}
              onChange={(event) => setParams((current) => ({ ...current, [field.key]: event.target.value }))}
              disabled={disabled}
            />
          </div>
        ))}
      </div>
      {missingRequired ? <p className="text-xs text-destructive">Cần nhập đủ ngưỡng trước khi bật mẫu này.</p> : null}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || invalid}
          onClick={() =>
            void onSave({
              code,
              name: definition.name,
              description: definition.description,
              mode: definition.mode,
              verification: definition.verification,
              params: paramValues,
              rewardVnd: pays ? (reward.trim() === "" ? null : rewardValue) : null,
              acceptDeadline: deadline === "" ? null : deadline,
              prorateAllowed: record?.prorateAllowed ?? definition.defaultProrateAllowed,
              enabled,
            })
          }
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Lưu mẫu
        </Button>
      </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function ReasonDialog({
  action,
  busy,
  onClose,
  onConfirm,
}: {
  action: ReasonAction | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (action) setReason("");
  }, [action]);
  const redraw = action?.kind === "redraw";

  return (
    <Dialog open={action !== null} onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{redraw ? "Bốc thăm lại" : "Bỏ nhiệm vụ gợi ý"}</DialogTitle>
          <DialogDescription>
            {redraw
              ? "Kết quả lần bốc trước được giữ trong lịch sử. Ghi rõ lý do bốc lại, ví dụ người trúng đang nghỉ phép."
              : "Nhiệm vụ này sẽ không được bốc thăm. Ghi rõ lý do."}
          </DialogDescription>
        </DialogHeader>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Lý do" rows={3} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Huỷ
          </Button>
          <Button onClick={() => void onConfirm(reason.trim())} disabled={busy || reason.trim() === ""}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {redraw ? "Bốc lại" : "Bỏ nhiệm vụ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmResultDialog({
  mission,
  employeeName,
  busy,
  onClose,
  onConfirm,
}: {
  mission: MissionRecord | null;
  employeeName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (status: "achieved" | "not_achieved", reason: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<"achieved" | "not_achieved" | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (mission) {
      setStatus(null);
      setReason("");
    }
  }, [mission]);

  return (
    <Dialog open={mission !== null} onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Xác nhận kết quả</DialogTitle>
          <DialogDescription>
            {employeeName} · {mission?.templateName}. Kết quả và lý do được ghi nhật ký.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <Button variant={status === "achieved" ? "default" : "outline"} onClick={() => setStatus("achieved")} disabled={busy}>
            Đạt
          </Button>
          <Button variant={status === "not_achieved" ? "destructive" : "outline"} onClick={() => setStatus("not_achieved")} disabled={busy}>
            Không đạt
          </Button>
        </div>
        <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Lý do (bắt buộc)" rows={3} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Huỷ
          </Button>
          <Button onClick={() => status && void onConfirm(status, reason.trim())} disabled={busy || status === null || reason.trim() === ""}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Lưu kết quả
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
