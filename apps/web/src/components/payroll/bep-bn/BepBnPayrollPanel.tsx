import { useEffect, useMemo, useState } from "react";
import { Loader2, Lock, Send } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { MissionsSection } from "./MissionsSection";
import type { BepBnPeriodData, BepBnPeriodSummary, UseBepBnData } from "./types";

interface BepBnPayrollPanelProps {
  useData: UseBepBnData;
  canEdit: boolean;
  canLock: boolean;
}

type PanelTab = "attendance" | "payroll" | "missions" | "employees";

export function BepBnPayrollPanel({ useData, canEdit, canLock }: BepBnPayrollPanelProps) {
  const { toast } = useToast();
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [tab, setTab] = useState<PanelTab>("attendance");
  const [confirmLock, setConfirmLock] = useState(false);
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

  const [publishing, setPublishing] = useState(false);
  const publish = async () => {
    if (!periodId) return;
    setPublishing(true);
    try {
      const count = await source.publishPayslips(periodId);
      toast({ title: "Đã phát hành phiếu lương", description: `${count} nhân viên xem được tại payroll.banhmique.vn.` });
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
      {source.periods.length > 0 ? (
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
        <TabsList className="max-w-full justify-start overflow-x-auto [&>*]:shrink-0">
          <TabsTrigger value="attendance">Chấm công</TabsTrigger>
          <TabsTrigger value="payroll">Bảng lương</TabsTrigger>
          <TabsTrigger value="missions">Nhiệm vụ thưởng</TabsTrigger>
          <TabsTrigger value="employees">Nhân viên</TabsTrigger>
        </TabsList>

        <TabsContent value="attendance" className="space-y-4">
          <UploadCard source={source} canEdit={canEdit} onImported={setPeriodId} />
          {periodId && source.dataLoading ? <LoadingCard /> : null}
          {source.data && !source.dataLoading ? (
            <AttendanceSection
              data={source.data}
              source={source}
              canEdit={canEdit}
              onOpenEmployees={() => setTab("employees")}
              onApproved={() => setTab("payroll")}
            />
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
            <PayrollDraftSection data={payrollData} source={source} canEdit={canEdit} />
          )}
        </TabsContent>

        <TabsContent value="missions" className="space-y-4">
          {source.data ? (
            <MissionsSection data={source.data} source={source} canEdit={canEdit} />
          ) : (
            <EmptyCard text="Chọn hoặc tạo kỳ lương ở tab Chấm công trước." />
          )}
        </TabsContent>

        <TabsContent value="employees" className="space-y-4">
          {source.data ? (
            <CatalogSection data={source.data} source={source} canEdit={canEdit} canManagePhones={canEdit} />
          ) : (
            <EmptyCard text="Danh mục nhân viên được tạo tự động khi upload bảng chấm công." />
          )}
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

function LoadingCard() {
  return (
    <Card>
      <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Đang tải dữ liệu…
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
