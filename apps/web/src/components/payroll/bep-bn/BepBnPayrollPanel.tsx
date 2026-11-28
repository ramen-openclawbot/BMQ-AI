import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, ChevronDown, Loader2, Lock, Send } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GpsAttendanceAdmin } from "@/components/payroll/bep-bn/GpsAttendanceAdmin";
import { ShiftBoard } from "@/components/payroll/bep-bn/ShiftBoard";
import { AttendanceBoard } from "@/components/payroll/bep-bn/AttendanceBoard";
import { DeliveryAdmin } from "@/components/payroll/bep-bn/DeliveryAdmin";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { applyIssueReviews } from "@/lib/payroll-bn/issue-review.ts";
import { AttendanceSection, UploadCard } from "./AttendanceSection";
import { PayrollDraftSection } from "./PayrollDraftSection";
import { CatalogSection } from "./CatalogSection";
import { TodayOverview, type TodayTarget } from "./TodayOverview";
import type { BepBnPeriodData, BepBnPeriodSummary, UseBepBnData } from "./types";
import { LoadingState } from "@/components/ui/loading";

interface BepBnPayrollPanelProps {
  useData: UseBepBnData;
  canEdit: boolean;
  canLock: boolean;
}

type PanelTab = "today" | "attendance" | "payroll" | "settings";
type SettingsSection = "employees" | "delivery" | "shifts" | "gps";

export function BepBnPayrollPanel({ useData, canEdit, canLock }: BepBnPayrollPanelProps) {
  const { toast } = useToast();
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>("today");
  const [openSections, setOpenSections] = useState<Set<SettingsSection>>(() => new Set<SettingsSection>(["employees"]));
  const toggleSection = (key: SettingsSection) =>
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const goSettings = (key: SettingsSection) => {
    setOpenSections((current) => new Set(current).add(key));
    setTab("settings");
    window.requestAnimationFrame(() => document.getElementById(`payroll-section-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const goFromToday = (target: TodayTarget) => goSettings(target);
  const [confirmLock, setConfirmLock] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [locking, setLocking] = useState(false);
  const source = useData(periodId);

  useEffect(() => {
    if (!periodId && source.periods.length > 0) setPeriodId(source.periods[0].id);
  }, [periodId, source.periods]);

  const selected: BepBnPeriodSummary | undefined = source.periods.find((period) => period.id === periodId);
  const approved = Boolean(source.attendanceApprovedAt);

  // The payroll uses the attendance after the reviewer's "không tính" decisions.
  const payrollData = useMemo<BepBnPeriodData | null>(
    () => (source.data ? { ...source.data, rows: applyIssueReviews(source.data.rows, source.issueReviews) } : null),
    [source.data, source.issueReviews],
  );

  const lock = async () => {
    if (!periodId) return;
    setLocking(true);
    try {
      await source.lockPeriod(periodId);
      toast({ title: "Đã chốt kỳ", description: "Kỳ đã khoá, không sửa và không ghi đè được nữa." });
      setConfirmLock(false);
    } catch (error) {
      if (error instanceof Error && error.name === "PayslipPublishError") {
        setConfirmLock(false);
        toast({ title: "Đã chốt kỳ, chưa phát hành phiếu lương", description: error.message, variant: "destructive" });
        return;
      }
      toast({
        title: "Không chốt được kỳ",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setLocking(false);
    }
  };

  // "Hồ sơ nhân viên" always works on the current month's open period: it is
  // opened automatically each month, and by hand here when it is still missing.
  const current = source.currentPeriod;
  const currentMonthLabel = current?.month ? `${current.month.slice(5, 7)}/${current.month.slice(0, 4)}` : "";
  const [opening, setOpening] = useState(false);
  const openCurrent = async () => {
    setOpening(true);
    try {
      const result = await source.openCurrentPeriod();
      setPeriodId(result.periodId);
      toast({
        title: result.created ? `Đã mở kỳ lương tháng ${currentMonthLabel}` : `Kỳ lương tháng ${currentMonthLabel} đã có sẵn`,
        description: result.created ? `Đã chép ${result.copiedEmployees} nhân viên đang làm từ kỳ trước.` : undefined,
      });
    } catch (error) {
      toast({
        title: "Không mở được kỳ lương",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setOpening(false);
    }
  };

  const [publishing, setPublishing] = useState(false);
  const publish = async () => {
    if (!periodId) return;
    setPublishing(true);
    try {
      const count = await source.publishPayslips(periodId);
      toast({ title: "Đã phát hành phiếu lương", description: `${count} nhân viên xem được tại luong.banhmique.vn.` });
    } catch (error) {
      toast({
        title: "Không phát hành được phiếu lương",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setPublishing(false);
    }
  };

  const status = !selected ? null : selected.status === "locked" ? "Đã chốt" : approved ? "Đã duyệt chấm công" : "Chưa duyệt chấm công";

  return (
    <div className="space-y-4">
      {source.periods.length > 0 && tab !== "today" ? (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select value={periodId ?? ""} onValueChange={(value) => setPeriodId(value)}>
                <SelectTrigger className="w-full sm:w-72" aria-label="Chọn tháng">
                  <SelectValue placeholder="Chọn tháng" />
                </SelectTrigger>
                <SelectContent>
                  {source.periods.map((period) => (
                    <SelectItem key={period.id} value={period.id}>
                      {period.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {status ? (
                <Badge variant={status === "Chưa duyệt chấm công" ? "outline" : "secondary"} className="w-fit">
                  {status}
                </Badge>
              ) : null}
            </div>
            {selected && selected.status === "locked" && canLock ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <span className="text-sm text-muted-foreground">
                  {source.publishedCount > 0
                    ? `Đã phát hành ${source.publishedCount} phiếu lương`
                    : "Chưa phát hành phiếu lương"}
                </span>
                <Button variant="outline" className="gap-2" onClick={() => void publish()} disabled={publishing}>
                  {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {source.publishedCount > 0 ? "Phát hành lại" : "Phát hành phiếu lương"}
                </Button>
              </div>
            ) : null}
            {selected && selected.status !== "locked" && approved && canLock ? (
              <Button variant="outline" className="gap-2" onClick={() => setConfirmLock(true)}>
                <Lock className="h-4 w-4" />
                Chốt kỳ
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {source.periodsError ? <ErrorCard message={source.periodsError} /> : null}
      {source.dataError ? <ErrorCard message={source.dataError} /> : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as PanelTab)} className="space-y-4">
        <TabsList className="grid h-auto w-full grid-cols-4 gap-1 p-1">
          <TabsTrigger value="today" className="px-1 py-2 text-xs sm:text-sm">Hôm nay</TabsTrigger>
          <TabsTrigger value="attendance" className="px-1 py-2 text-xs sm:text-sm">Chấm công</TabsTrigger>
          <TabsTrigger value="payroll" className="px-1 py-2 text-xs sm:text-sm">Bảng lương</TabsTrigger>
          <TabsTrigger value="settings" className="px-1 py-2 text-xs sm:text-sm">Nhân viên</TabsTrigger>
        </TabsList>

        <TabsContent value="today" className="space-y-4">
          {tab === "today" ? <TodayOverview employees={source.data?.employees ?? []} canEdit={canEdit} onGo={goFromToday} /> : null}
        </TabsContent>

        <TabsContent value="attendance" className="space-y-4">
          <UploadCard source={source} canEdit={canEdit} onImported={setPeriodId} />
          {periodId && source.dataLoading ? <LoadingCard /> : null}
          {source.data && !source.dataLoading ? (
            <AttendanceSection
              data={source.data}
              source={source}
              canEdit={canEdit}
              onOpenEmployees={() => goSettings("employees")}
              onApproved={() => setTab("payroll")}
            />
          ) : null}
          {canEdit ? (
            <Section id="board" title="Xem ngày khác · xếp hạng đúng giờ" open={boardOpen} onToggle={() => setBoardOpen((value) => !value)}>
              <AttendanceBoard />
            </Section>
          ) : null}
        </TabsContent>

        <TabsContent value="payroll" className="space-y-4">
          {!payrollData ? (
            <EmptyCard text="Chưa có dữ liệu. Upload bảng chấm công ở tab Chấm công." />
          ) : !approved && payrollData.period.status !== "locked" ? (
            <Card>
              <CardContent className="flex flex-col gap-3 py-6 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span>Bảng lương được tạo sau khi bảng chấm công tháng này được duyệt.</span>
                <Button variant="outline" className="self-start" onClick={() => setTab("attendance")}>
                  Sang tab Chấm công
                </Button>
              </CardContent>
            </Card>
          ) : (
            <PayrollDraftSection
              data={payrollData}
              source={source}
              canEdit={canEdit}
              issueReviews={source.issueReviews}
            />
          )}
        </TabsContent>

        <TabsContent value="settings" className="space-y-3">
          {canEdit && current && !current.period ? (
            <Card className="border-amber-300" data-open-period>
              <CardContent className="flex flex-col gap-3 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span>Chưa có kỳ lương tháng {currentMonthLabel}. Mở kỳ để thêm, sửa nhân viên (chép từ kỳ trước).</span>
                <Button className="gap-2 self-start sm:self-auto" onClick={() => void openCurrent()} disabled={opening} data-open-period-run>
                  {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
                  Mở kỳ tháng {currentMonthLabel}
                </Button>
              </CardContent>
            </Card>
          ) : null}
          {canEdit && current?.period && selected && selected.id !== current.period.id && selected.status === "locked" ? (
            <Card className="border-amber-300" data-switch-period>
              <CardContent className="flex flex-col gap-3 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span>Kỳ {selected.code} đã chốt, không sửa được. Sửa nhân viên ở kỳ đang mở {current.period.code}.</span>
                <Button variant="outline" className="self-start sm:self-auto" onClick={() => setPeriodId(current.period ? current.period.id : null)} data-switch-period-run>
                  Sang kỳ {current.period.code}
                </Button>
              </CardContent>
            </Card>
          ) : null}
          <Section id="employees" title="Hồ sơ nhân viên" open={openSections.has("employees")} onToggle={() => toggleSection("employees")}>
            {source.data ? (
              <CatalogSection data={source.data} source={source} canEdit={canEdit} canManagePhones={canEdit} />
            ) : (
              <EmptyCard text="Chưa có hồ sơ nhân viên. Mở kỳ lương tháng này để bắt đầu thêm nhân viên." />
            )}
          </Section>
          <Section id="delivery" title="Giao hàng · phân công điểm · công tháng" open={openSections.has("delivery")} onToggle={() => toggleSection("delivery")}>
            <DeliveryAdmin employees={source.data?.employees ?? []} canEdit={canEdit} />
          </Section>
          {canEdit ? (
            <Section id="shifts" title="Xếp ca bếp" open={openSections.has("shifts")} onToggle={() => toggleSection("shifts")}>
              <ShiftBoard />
            </Section>
          ) : null}
          {canEdit ? (
            <Section id="gps" title="Chấm công GPS · duyệt ngày công · máy" open={openSections.has("gps")} onToggle={() => toggleSection("gps")}>
              <GpsAttendanceAdmin employees={source.data?.employees ?? []} />
            </Section>
          ) : null}
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmLock} onOpenChange={setConfirmLock}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Chốt {selected?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Sau khi chốt, kỳ bị khoá: không nhập thêm chấm công, không điều chỉnh, không ghi đè. Không có thao tác mở khoá.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={locking}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void lock();
              }}
              disabled={locking}
            >
              {locking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Chốt kỳ
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Collapsible group: only the header line until opened; content mounts on open. */
function Section({ id, title, open, onToggle, children }: { id: string; title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section id={`payroll-section-${id}`} className="scroll-mt-4" data-payroll-section={id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-left text-sm font-semibold hover:bg-muted/40",
          open && "rounded-b-none border-b-0",
        )}
      >
        {title}
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open ? <div className="rounded-b-xl border border-t-0 p-2 sm:p-3 [&>*]:shadow-none">{children}</div> : null}
    </section>
  );
}

function LoadingCard() {
  return (
    <Card>
      <CardContent className="pt-6">
        <LoadingState flat label="Đang tải dữ liệu…" />
      </CardContent>
    </Card>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive/40">
      <CardContent role="alert" className="py-3 text-sm text-destructive">
        {message}
      </CardContent>
    </Card>
  );
}
