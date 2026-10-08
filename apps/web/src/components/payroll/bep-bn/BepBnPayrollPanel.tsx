import { useEffect, useState } from "react";
import { CalendarPlus, Loader2, Lock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { AttendanceSection } from "./AttendanceSection";
import { PayrollDraftSection } from "./PayrollDraftSection";
import { CatalogSection } from "./CatalogSection";
import { PeriodDialog } from "./PeriodDialog";
import type { BepBnPeriodSummary, UseBepBnData } from "./types";

interface BepBnPayrollPanelProps {
  useData: UseBepBnData;
  canEdit: boolean;
  canLock: boolean;
}

export function BepBnPayrollPanel({ useData, canEdit, canLock }: BepBnPayrollPanelProps) {
  const { toast } = useToast();
  const [periodId, setPeriodId] = useState<string | null>(null);
  const [confirmLock, setConfirmLock] = useState(false);
  const [locking, setLocking] = useState(false);
  const [creating, setCreating] = useState(false);
  const source = useData(periodId);

  useEffect(() => {
    if (!periodId && source.periods.length > 0) setPeriodId(source.periods[0].id);
  }, [periodId, source.periods]);

  const selected: BepBnPeriodSummary | undefined = source.periods.find((period) => period.id === periodId);

  const lock = async () => {
    if (!periodId) return;
    setLocking(true);
    try {
      await source.lockPeriod(periodId);
      toast({ title: "Đã chốt kỳ", description: "Kỳ đã khoá, không sửa và không ghi đè được nữa." });
      setConfirmLock(false);
    } catch (error) {
      toast({
        title: "Không chốt được kỳ",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setLocking(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lương Bếp BN</CardTitle>
          <CardDescription>
            Upload chấm công từ máy, xem trước, lập bảng lương nháp và điều chỉnh có lý do. Hệ thống không tự chốt kỳ.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select value={periodId ?? ""} onValueChange={setPeriodId} disabled={source.periods.length === 0}>
              <SelectTrigger className="w-full sm:w-72" aria-label="Chọn kỳ lương">
                <SelectValue placeholder={source.periodsLoading ? "Đang tải kỳ…" : "Chưa có kỳ lương"} />
              </SelectTrigger>
              <SelectContent>
                {source.periods.map((period) => (
                  <SelectItem key={period.id} value={period.id}>
                    {period.code} · {period.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected ? (
              <Badge variant={selected.status === "locked" ? "secondary" : "outline"} className="w-fit">
                {selected.status === "locked" ? "Đã chốt" : "Nháp, chưa chốt"}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {canEdit ? (
              <Button variant="outline" className="gap-2" onClick={() => setCreating(true)}>
                <CalendarPlus className="h-4 w-4" />
                Tạo kỳ
              </Button>
            ) : null}
            {selected && selected.status !== "locked" && canLock ? (
              <Button variant="outline" className="gap-2" onClick={() => setConfirmLock(true)}>
                <Lock className="h-4 w-4" />
                Chốt kỳ
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {source.periodsError ? <ErrorCard message={source.periodsError} /> : null}

      {!source.periodsLoading && !source.periodsError && source.periods.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Chưa có kỳ lương Bếp BN nào. {canEdit ? "Bấm “Tạo kỳ”, sau đó thêm danh mục nhân viên của kỳ trước khi upload chấm công." : "Người có quyền sửa lương cần tạo kỳ trước."}
          </CardContent>
        </Card>
      ) : null}

      {periodId && source.dataLoading ? (
        <Card>
          <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Đang tải dữ liệu kỳ…
          </CardContent>
        </Card>
      ) : null}

      {source.dataError ? <ErrorCard message={source.dataError} /> : null}

      {source.data && !source.dataLoading ? (
        <Tabs defaultValue="attendance" className="space-y-4">
          <TabsList className="max-w-full justify-start overflow-x-auto [&>*]:shrink-0">
            <TabsTrigger value="attendance">Chấm công</TabsTrigger>
            <TabsTrigger value="payroll">Bảng lương nháp</TabsTrigger>
            <TabsTrigger value="catalog">Nhân viên</TabsTrigger>
          </TabsList>
          <TabsContent value="attendance">
            <AttendanceSection data={source.data} source={source} canEdit={canEdit} />
          </TabsContent>
          <TabsContent value="payroll">
            <PayrollDraftSection data={source.data} source={source} canEdit={canEdit} />
          </TabsContent>
          <TabsContent value="catalog">
            <CatalogSection data={source.data} source={source} canEdit={canEdit} />
          </TabsContent>
        </Tabs>
      ) : null}

      {canEdit ? <PeriodDialog open={creating} onOpenChange={setCreating} source={source} onCreated={setPeriodId} /> : null}

      <AlertDialog open={confirmLock} onOpenChange={setConfirmLock}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Chốt kỳ {selected?.code}?</AlertDialogTitle>
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

function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive/40">
      <CardContent role="alert" className="py-3 text-sm text-destructive">
        {message}
      </CardContent>
    </Card>
  );
}
