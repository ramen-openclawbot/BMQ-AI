import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BadgeCheck, Banknote, Check, Download, FileUp, Loader2, Mail, RefreshCw, Search, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingState } from "@/components/ui/loading";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import {
  DealerSignupApiError,
  getDealerSignupDocumentUrl,
  getDealerSignupPaymentSettings,
  reviewDealerSignup,
  setDealerSignupPaymentSettings,
  uploadDealerSignedContract,
  type DealerSignupDocumentKind,
  type DealerSignupPaymentSettings,
  type DealerSignupReviewResult,
} from "@/lib/dealer-signup-api";

/*
 * CRM "Đại lý mới": the queue of /dai-ly-moi applications. Owner / crm edit
 * approve or reject; accounting downloads the generated contract, stamps it by
 * hand and uploads the stamped copy. After the dealer uploads a bank slip,
 * owner / accounting confirm the transfer (or send the slip back with a
 * reason); only then can the dealer order. Every permission is enforced again by the
 * dealer-signup-review Edge Function.
 */

type Application = {
  id: string;
  application_code: string;
  status: string;
  approval_mode: string | null;
  applicant_name: string;
  business_name: string;
  cccd: string;
  cccd_valid_until: string;
  phone: string;
  email: string;
  address_text: string;
  nearest_distance_m: number | null;
  unlocated_dealer_count: number;
  last_error_code: string | null;
  reject_reason: string | null;
  crm_customer_id: string | null;
  contract_draft_path: string | null;
  contract_signed_path: string | null;
  contract_signed_uploaded_at: string | null;
  slip_storage_path: string | null;
  slip_uploaded_at: string | null;
  slip_token_expires_at: string | null;
  slip_reject_reason: string | null;
  payment_confirmed_at: string | null;
  phone_verified_at: string | null;
  email_verified_at: string | null;
  reviewed_at: string | null;
  created_at: string;
};

type Filter = "pending" | "waiting_slip" | "payment" | "active" | "rejected";

const QUERY_KEY = ["crm-dealer-signup-applications"];
const COLUMNS =
  "id, application_code, status, approval_mode, applicant_name, business_name, cccd, cccd_valid_until, phone, email, address_text, nearest_distance_m, unlocated_dealer_count, last_error_code, reject_reason, crm_customer_id, contract_draft_path, contract_signed_path, contract_signed_uploaded_at, slip_storage_path, slip_uploaded_at, slip_token_expires_at, slip_reject_reason, payment_confirmed_at, phone_verified_at, email_verified_at, reviewed_at, created_at";

const FILTER_STATUSES: Record<Filter, string[]> = {
  pending: ["manual_review", "contract_sent", "email_failed"],
  waiting_slip: ["approved_waiting_slip"],
  payment: ["slip_submitted"],
  active: ["active"],
  rejected: ["rejected_manual", "rejected_too_close"],
};

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  manual_review: { label: "Chờ duyệt", tone: "border-amber-300 bg-amber-50 text-amber-800" },
  contract_sent: { label: "Đã gửi hợp đồng · chờ duyệt", tone: "border-amber-300 bg-amber-50 text-amber-800" },
  email_failed: { label: "Lỗi gửi thư · chờ duyệt", tone: "border-red-300 bg-red-50 text-red-700" },
  approved_waiting_slip: { label: "Chờ bank slip", tone: "border-sky-300 bg-sky-50 text-sky-800" },
  slip_submitted: { label: "Chờ xác nhận tiền", tone: "border-violet-300 bg-violet-50 text-violet-800" },
  active: { label: "Đại lý chính thức", tone: "border-emerald-300 bg-emerald-50 text-emerald-800" },
  rejected_manual: { label: "Đã từ chối", tone: "border-slate-300 bg-slate-50 text-slate-600" },
  rejected_too_close: { label: "Gần đại lý cũ", tone: "border-slate-300 bg-slate-50 text-slate-600" },
};

const REASON_LABEL: Record<string, string> = {
  dealer_location_missing: "Có đại lý chưa có vị trí trên hệ thống",
  duplicate_phone: "Số điện thoại đã thuộc khách hàng khác",
  route_provider_failed: "Không đo được quãng đường",
};

const ERROR_MESSAGE: Record<string, string> = {
  forbidden: "Anh/chị không có quyền thực hiện thao tác này.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  duplicate_phone: "Số điện thoại đã thuộc khách hàng khác. Xử lý số ở khách cũ trước khi duyệt.",
  application_not_approvable: "Hồ sơ này không còn ở trạng thái chờ duyệt.",
  application_not_rejectable: "Hồ sơ này không còn ở trạng thái chờ duyệt.",
  application_not_found: "Không tìm thấy hồ sơ.",
  document_missing: "Chưa có giấy tờ này.",
  invalid_file_type: "Chỉ nhận PDF, JPEG hoặc PNG.",
  file_too_large: "Tệp vượt quá 10 MB.",
  reject_reason_required: "Vui lòng nhập lý do từ chối.",
  reject_reason_too_long: "Lý do tối đa 500 ký tự.",
  application_not_awaiting_payment: "Hồ sơ này không còn ở trạng thái chờ xác nhận tiền.",
  slip_reject_reason_required: "Vui lòng nhập lý do.",
};

const fmtDateTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
const fmtDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof DealerSignupApiError) {
    return (error.code && ERROR_MESSAGE[error.code]) || error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

async function openDocument(applicationId: string, kind: DealerSignupDocumentKind) {
  // Open the tab synchronously so the browser keeps it as a user gesture.
  const tab = window.open("", "_blank");
  try {
    const { url } = await getDealerSignupDocumentUrl({ applicationId, kind });
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (error) {
    tab?.close();
    throw error;
  }
}

export function DealerSignupReviewPanel({
  canView,
  canReview,
  canUploadContract,
  canConfirmPayment = false,
  canEditPaymentSettings = false,
}: {
  canView: boolean;
  canReview: boolean;
  canUploadContract: boolean;
  canConfirmPayment?: boolean;
  canEditPaymentSettings?: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("pending");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Application | null>(null);

  const query = useQuery({
    queryKey: QUERY_KEY,
    enabled: canView,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("dealer_signup_applications")
        .select(COLUMNS)
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data || []) as Application[];
    },
  });

  const rows = useMemo(() => query.data ?? [], [query.data]);
  const counts = useMemo(() => {
    const result: Record<Filter, number> = { pending: 0, waiting_slip: 0, payment: 0, active: 0, rejected: 0 };
    for (const row of rows) {
      for (const key of Object.keys(FILTER_STATUSES) as Filter[]) {
        if (FILTER_STATUSES[key].includes(row.status)) result[key] += 1;
      }
    }
    return result;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = fold(search.trim());
    return rows.filter((row) => {
      if (!FILTER_STATUSES[filter].includes(row.status)) return false;
      if (!needle) return true;
      return fold(`${row.application_code} ${row.business_name} ${row.applicant_name} ${row.phone}`).includes(needle);
    });
  }, [rows, filter, search]);

  // Keep the open dialog in sync with refetched data.
  const current = selected ? rows.find((row) => row.id === selected.id) ?? selected : null;

  if (!canView) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Bạn cần quyền CRM để xem hồ sơ đại lý mới.
        </CardContent>
      </Card>
    );
  }

  if (query.isLoading) {
    return <Card><CardContent className="pt-6"><LoadingState flat rows={4} label="Đang tải hồ sơ đại lý mới..." /></CardContent></Card>;
  }

  if (query.error) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-2">
            <p>Không tải được hồ sơ đại lý mới.</p>
            <Button size="sm" variant="outline" onClick={() => query.refetch()}>Tải lại</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const chips: Array<{ id: Filter; label: string }> = [
    { id: "pending", label: "Chờ duyệt" },
    { id: "waiting_slip", label: "Chờ bank slip" },
    { id: "payment", label: "Chờ xác nhận tiền" },
    { id: "active", label: "Chính thức" },
    { id: "rejected", label: "Từ chối" },
  ];

  return (
    <Card data-dealer-signup-review="v1">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="text-lg">Đại lý mới</CardTitle>
          <CardDescription>
            Duyệt hồ sơ để tạo khách trong CRM và gửi thư chúc mừng kèm link upload bank slip. Khách đăng nhập được ngay
            nhưng chỉ đặt bánh sau khi kế toán xác nhận đã nhận tiền.
          </CardDescription>
        </div>
        {canEditPaymentSettings ? (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setSettingsOpen(true)} data-dealer-payment-settings-open>
            <Banknote className="mr-1 h-4 w-4" />
            Tài khoản nhận tiền
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Lọc hồ sơ">
            {chips.map((chip) => (
              <Button
                key={chip.id}
                type="button"
                size="sm"
                role="tab"
                aria-selected={filter === chip.id}
                variant={filter === chip.id ? "default" : "outline"}
                onClick={() => setFilter(chip.id)}
                data-dealer-signup-filter={chip.id}
              >
                {chip.label} · {counts[chip.id]}
              </Button>
            ))}
          </div>
          <div className="relative w-full md:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Tìm mã hồ sơ, tên, SĐT"
              className="pl-9"
              aria-label="Tìm hồ sơ"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {filter === "pending" && !search ? "Không có hồ sơ nào chờ duyệt." : "Không có hồ sơ phù hợp."}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border" data-dealer-signup-list>
            {visible.map((row) => {
              const status = STATUS_LABEL[row.status] ?? { label: row.status, tone: "" };
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                    onClick={() => setSelected(row)}
                    data-dealer-signup-row={row.id}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{row.business_name}</span>
                        <Badge variant="outline" className={`font-normal ${status.tone}`}>{status.label}</Badge>
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {row.applicant_name} · {row.phone} · {row.address_text}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {row.application_code} · gửi {fmtDateTime(row.created_at)}
                        {row.status === "slip_submitted" && row.slip_uploaded_at ? ` · bank slip ${fmtDateTime(row.slip_uploaded_at)}` : ""}
                        {["approved_waiting_slip", "slip_submitted"].includes(row.status) && !row.contract_signed_path ? " · hợp đồng chưa đóng dấu" : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm text-primary">Xem</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <ApplicationDialog
        application={current}
        canReview={canReview}
        canUploadContract={canUploadContract}
        canConfirmPayment={canConfirmPayment}
        onClose={() => setSelected(null)}
      />
      {canEditPaymentSettings ? <PaymentSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} /> : null}
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value || "—"}</dd>
    </div>
  );
}

function ApplicationDialog({
  application,
  canReview,
  canUploadContract,
  canConfirmPayment,
  onClose,
}: {
  application: Application | null;
  canReview: boolean;
  canUploadContract: boolean;
  canConfirmPayment: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"view" | "approve" | "reject" | "confirm_payment" | "reject_slip">("view");
  const [reason, setReason] = useState("");
  const [busyDoc, setBusyDoc] = useState<DealerSignupDocumentKind | null>(null);

  const close = () => {
    setMode("view");
    setReason("");
    onClose();
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const review = useMutation({
    mutationFn: (input: {
      action: "approve" | "reject" | "resend_slip_link" | "regenerate_contract" | "confirm_payment" | "reject_slip";
      reason?: string;
    }) =>
      reviewDealerSignup({ action: input.action, applicationId: application!.id, reason: input.reason }),
    onSuccess: (result: DealerSignupReviewResult, input) => {
      void refresh();
      queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] });
      setMode("view");
      setReason("");
      if (input.action === "approve") {
        const warnings = [
          result.contract_ready === false ? "chưa tạo được hợp đồng (bấm Tạo lại hợp đồng)" : "",
          result.email_sent === false ? "chưa gửi được thư (bấm Gửi lại link)" : "",
        ].filter(Boolean);
        toast({
          title: result.already_approved ? "Hồ sơ đã được duyệt trước đó" : "Đã duyệt hồ sơ",
          description: warnings.length ? `Khách đã vào CRM, nhưng ${warnings.join(" và ")}.` : "Khách đã vào CRM và nhận thư chúc mừng kèm link bank slip.",
          variant: warnings.length ? "destructive" : undefined,
        });
      } else if (input.action === "reject") {
        toast({ title: "Đã từ chối hồ sơ", description: result.email_sent === false ? "Chưa gửi được thư báo cho khách." : "Khách đã nhận thư báo." });
      } else if (input.action === "confirm_payment") {
        toast({
          title: result.already_active ? "Khoản tiền đã được xác nhận trước đó" : "Đã xác nhận tiền",
          description: "Đại lý đặt bánh được từ bây giờ.",
        });
        close();
      } else if (input.action === "reject_slip") {
        toast({
          title: "Đã gửi lại bank slip cho khách",
          description: result.email_sent === false ? "Chưa gửi được thư, bấm Gửi lại link." : "Khách nhận thư kèm lý do và link mới.",
          variant: result.email_sent === false ? "destructive" : undefined,
        });
        close();
      } else if (input.action === "resend_slip_link") {
        toast({ title: result.email_sent === false ? "Chưa gửi được thư" : "Đã gửi lại link bank slip" });
      } else {
        toast({ title: result.contract_ready === false ? "Chưa tạo được hợp đồng" : "Đã tạo hợp đồng" });
      }
    },
    onError: (error) => {
      toast({ title: "Không thực hiện được", description: messageFor(error, "Vui lòng thử lại."), variant: "destructive" });
    },
  });

  const uploadSigned = useMutation({
    mutationFn: (file: File) => uploadDealerSignedContract({ applicationId: application!.id, file }),
    onSuccess: () => {
      void refresh();
      toast({ title: "Đã lưu hợp đồng đóng dấu" });
    },
    onError: (error) => {
      toast({ title: "Không upload được hợp đồng", description: messageFor(error, "Vui lòng thử lại."), variant: "destructive" });
    },
  });

  const download = async (kind: DealerSignupDocumentKind) => {
    if (!application) return;
    setBusyDoc(kind);
    try {
      await openDocument(application.id, kind);
    } catch (error) {
      toast({ title: "Không tải được", description: messageFor(error, "Vui lòng thử lại."), variant: "destructive" });
    } finally {
      setBusyDoc(null);
    }
  };

  if (!application) return null;

  const status = STATUS_LABEL[application.status] ?? { label: application.status, tone: "" };
  const isPending = ["manual_review", "contract_sent", "email_failed"].includes(application.status);
  const isApproved = ["approved_waiting_slip", "slip_submitted", "active"].includes(application.status);
  const awaitingPayment = application.status === "slip_submitted";
  const busy = review.isPending || uploadSigned.isPending;
  const reviewReason = (application.last_error_code && REASON_LABEL[application.last_error_code])
    || (application.unlocated_dealer_count > 0 ? `Có ${application.unlocated_dealer_count} đại lý chưa có vị trí trên hệ thống` : "");
  const trimmedReason = reason.trim();

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl" data-dealer-signup-dialog={application.id}>
        <DialogHeader>
          <DialogTitle className="pr-6">{application.business_name}</DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              <span>{application.application_code}</span>
              <Badge variant="outline" className={`font-normal ${status.tone}`}>{status.label}</Badge>
              {application.approval_mode === "auto" ? <Badge variant="outline" className="font-normal">Duyệt tự động</Badge> : null}
            </div>
          </DialogDescription>
        </DialogHeader>

        <dl className="space-y-1.5">
          <Field label="Họ tên" value={application.applicant_name} />
          <Field label="CCCD" value={`${application.cccd} · hết hạn ${fmtDate(application.cccd_valid_until)}`} />
          <Field label="Điện thoại" value={`${application.phone}${application.phone_verified_at ? " · đã xác minh" : ""}`} />
          <Field label="Email" value={`${application.email}${application.email_verified_at ? " · đã xác minh" : ""}`} />
          <Field label="Địa chỉ" value={application.address_text} />
          <Field
            label="Đại lý gần nhất"
            value={application.nearest_distance_m !== null ? `${(application.nearest_distance_m / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} km đường xe máy` : ""}
          />
          {isPending && reviewReason ? <Field label="Lý do xét tay" value={reviewReason} /> : null}
          {application.reject_reason ? <Field label="Lý do từ chối" value={application.reject_reason} /> : null}
          <Field label="Ngày gửi" value={fmtDateTime(application.created_at)} />
          {application.reviewed_at ? <Field label="Ngày duyệt" value={fmtDateTime(application.reviewed_at)} /> : null}
          {application.slip_reject_reason && application.status === "approved_waiting_slip" ? (
            <Field label="Bank slip bị trả lại" value={application.slip_reject_reason} />
          ) : null}
          {application.payment_confirmed_at ? <Field label="Xác nhận tiền" value={fmtDateTime(application.payment_confirmed_at)} /> : null}
        </dl>

        {isApproved ? (
          <div className="space-y-3 rounded-lg border p-3" data-dealer-signup-documents>
            <p className="text-sm font-medium">Giấy tờ</p>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <p>Hợp đồng</p>
                <p className="text-xs text-muted-foreground">
                  {application.contract_signed_path
                    ? `Đã đóng dấu · ${fmtDateTime(application.contract_signed_uploaded_at)}`
                    : application.contract_draft_path
                      ? "Chưa đóng dấu"
                      : "Chưa tạo"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {application.contract_draft_path ? (
                  <Button size="sm" variant="outline" disabled={busyDoc !== null} onClick={() => download("contract_draft")}>
                    {busyDoc === "contract_draft" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
                    Tải hợp đồng
                  </Button>
                ) : canReview ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => review.mutate({ action: "regenerate_contract" })}>
                    <RefreshCw className="mr-1 h-4 w-4" />
                    Tạo lại hợp đồng
                  </Button>
                ) : null}
                {application.contract_signed_path ? (
                  <Button size="sm" variant="outline" disabled={busyDoc !== null} onClick={() => download("contract_signed")}>
                    {busyDoc === "contract_signed" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
                    Bản đóng dấu
                  </Button>
                ) : null}
                {canUploadContract && application.contract_draft_path ? (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) uploadSigned.mutate(file);
                      }}
                    />
                    <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
                      {uploadSigned.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileUp className="mr-1 h-4 w-4" />}
                      {application.contract_signed_path ? "Upload lại" : "Upload bản đóng dấu"}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <div className="text-sm">
                <p>Bank slip</p>
                <p className="text-xs text-muted-foreground">
                  {application.slip_uploaded_at
                    ? `Khách đã gửi · ${fmtDateTime(application.slip_uploaded_at)}`
                    : application.slip_token_expires_at
                      ? `Chưa có · link hết hạn ${fmtDate(application.slip_token_expires_at)}`
                      : "Chưa có"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {application.slip_storage_path ? (
                  <Button size="sm" variant="outline" disabled={busyDoc !== null} onClick={() => download("slip")}>
                    {busyDoc === "slip" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
                    Xem bank slip
                  </Button>
                ) : canReview && application.status === "approved_waiting_slip" ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => review.mutate({ action: "resend_slip_link" })}>
                    <Mail className="mr-1 h-4 w-4" />
                    Gửi lại link
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {mode === "approve" ? (
          <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            <p>
              Duyệt sẽ tạo khách <b>{application.business_name}</b> trong CRM, tạo hợp đồng và gửi thư chúc mừng tới{" "}
              <b>{application.email}</b> kèm link upload bank slip. Khách đăng nhập được bằng số {application.phone} nhưng
              chưa đặt bánh được cho tới khi có bank slip.
            </p>
          </div>
        ) : null}

        {mode === "confirm_payment" ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            Xác nhận đã nhận tiền chuyển khoản của <b>{application.business_name}</b>. Đại lý sẽ đặt bánh được ngay.
            Hãy mở bank slip và đối chiếu với sao kê trước khi xác nhận.
          </div>
        ) : null}

        {mode === "reject_slip" ? (
          <div className="space-y-2">
            <Label htmlFor="dealer-signup-slip-reason">Lý do (khách nhận trong thư, kèm link gửi bank slip mới)</Label>
            <Textarea
              id="dealer-signup-slip-reason"
              value={reason}
              maxLength={500}
              rows={3}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ví dụ: Chưa thấy khoản chuyển 1.000.000 đ với nội dung BMQ DLM-..."
            />
            <p className="text-right text-xs text-muted-foreground">{reason.length}/500</p>
          </div>
        ) : null}

        {awaitingPayment && canConfirmPayment ? (
          <DialogFooter className="gap-2 sm:gap-2" data-dealer-payment-actions>
            {mode === "view" ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setMode("reject_slip")}>
                  <X className="mr-1 h-4 w-4" />
                  Chưa nhận được
                </Button>
                <Button disabled={busy} onClick={() => setMode("confirm_payment")} data-dealer-payment-confirm>
                  <BadgeCheck className="mr-1 h-4 w-4" />
                  Đã nhận tiền
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={busy} onClick={() => { setMode("view"); setReason(""); }}>
                  Quay lại
                </Button>
                {mode === "confirm_payment" ? (
                  <Button disabled={busy} onClick={() => review.mutate({ action: "confirm_payment" })}>
                    {review.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <BadgeCheck className="mr-1 h-4 w-4" />}
                    Xác nhận đã nhận tiền
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    disabled={busy || !trimmedReason}
                    onClick={() => review.mutate({ action: "reject_slip", reason: trimmedReason })}
                  >
                    {review.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <X className="mr-1 h-4 w-4" />}
                    Trả lại bank slip
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        ) : null}
        {awaitingPayment && !canConfirmPayment ? (
          <p className="text-sm text-muted-foreground">Chủ hoặc kế toán sẽ đối chiếu và xác nhận khoản tiền này.</p>
        ) : null}

        {mode === "reject" ? (
          <div className="space-y-2">
            <Label htmlFor="dealer-signup-reject-reason">Lý do từ chối (khách sẽ nhận trong thư)</Label>
            <Textarea
              id="dealer-signup-reject-reason"
              value={reason}
              maxLength={500}
              rows={3}
              autoFocus
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ví dụ: Khu vực này đã có đại lý BMQ phục vụ."
            />
            <p className="text-right text-xs text-muted-foreground">{reason.length}/500</p>
          </div>
        ) : null}

        {isPending && canReview ? (
          <DialogFooter className="gap-2 sm:gap-2">
            {mode === "view" ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => setMode("reject")}>
                  <X className="mr-1 h-4 w-4" />
                  Từ chối
                </Button>
                <Button disabled={busy} onClick={() => setMode("approve")} data-dealer-signup-approve>
                  <Check className="mr-1 h-4 w-4" />
                  Duyệt
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={busy} onClick={() => { setMode("view"); setReason(""); }}>
                  Quay lại
                </Button>
                {mode === "approve" ? (
                  <Button disabled={busy} onClick={() => review.mutate({ action: "approve" })}>
                    {review.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
                    Xác nhận duyệt
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    disabled={busy || !trimmedReason}
                    onClick={() => review.mutate({ action: "reject", reason: trimmedReason })}
                  >
                    {review.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <X className="mr-1 h-4 w-4" />}
                    Xác nhận từ chối
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        ) : null}
        {isPending && !canReview ? (
          <p className="text-sm text-muted-foreground">Chỉ chủ hoặc người có quyền sửa CRM mới duyệt được hồ sơ.</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const EMPTY_SETTINGS = {
  bank_name: "",
  bank_bin: "",
  account_number: "",
  account_name: "",
  amount_vnd: "1000000",
  transfer_note_template: "BMQ {application_code}",
};

function PaymentSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY_SETTINGS);
  const settings = useQuery({
    queryKey: ["dealer-signup-payment-settings"],
    enabled: open,
    queryFn: async () => (await getDealerSignupPaymentSettings()).payment_settings ?? null,
  });

  useEffect(() => {
    if (!open || settings.isLoading) return;
    const value = settings.data;
    setForm(value
      ? { ...value, amount_vnd: String(value.amount_vnd) }
      : EMPTY_SETTINGS);
  }, [open, settings.isLoading, settings.data]);

  const save = useMutation({
    mutationFn: () =>
      setDealerSignupPaymentSettings({
        settings: {
          ...form,
          bank_name: form.bank_name.trim(),
          bank_bin: form.bank_bin.trim(),
          account_number: form.account_number.trim(),
          account_name: form.account_name.trim(),
          amount_vnd: Number(form.amount_vnd.replace(/\D/g, "")),
          transfer_note_template: form.transfer_note_template.trim(),
        } as DealerSignupPaymentSettings,
      }),
    onSuccess: () => {
      void settings.refetch();
      toast({ title: "Đã lưu tài khoản nhận tiền", description: "Thư và trang bank slip dùng thông tin mới từ bây giờ." });
      onClose();
    },
    onError: (error) => {
      toast({ title: "Chưa lưu được", description: messageFor(error, "Vui lòng kiểm tra lại."), variant: "destructive" });
    },
  });

  const set = (key: keyof typeof EMPTY_SETTINGS) => (event: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));
  const amount = Number(form.amount_vnd.replace(/\D/g, ""));
  const valid =
    form.bank_name.trim().length >= 2 &&
    /^\d{6}$/.test(form.bank_bin.trim()) &&
    /^\d{4,32}$/.test(form.account_number.trim()) &&
    form.account_name.trim().length >= 2 &&
    amount > 0 &&
    form.transfer_note_template.includes("{application_code}");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg" data-dealer-payment-settings>
        <DialogHeader>
          <DialogTitle>Tài khoản nhận tiền đại lý mới</DialogTitle>
          <DialogDescription>
            Hiện trong thư gửi khách và trang gửi bank slip, kèm mã QR chuyển khoản. Chỉ chủ xem và sửa được.
          </DialogDescription>
        </DialogHeader>
        {settings.isLoading ? (
          <LoadingState flat rows={3} label="Đang tải..." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="dps-bank">Ngân hàng</Label>
              <Input id="dps-bank" value={form.bank_name} onChange={set("bank_name")} placeholder="Ví dụ: Techcombank" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dps-bin">Mã BIN ngân hàng</Label>
              <Input id="dps-bin" value={form.bank_bin} onChange={set("bank_bin")} inputMode="numeric" maxLength={6} placeholder="970407" />
              <p className="text-xs text-muted-foreground">6 số, dùng để tạo mã QR (VietQR).</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dps-account">Số tài khoản</Label>
              <Input id="dps-account" value={form.account_number} onChange={set("account_number")} inputMode="numeric" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="dps-name">Chủ tài khoản</Label>
              <Input id="dps-name" value={form.account_name} onChange={set("account_name")} placeholder="Viết hoa không dấu như trên ngân hàng" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dps-amount">Số tiền (đ)</Label>
              <Input id="dps-amount" value={form.amount_vnd} onChange={set("amount_vnd")} inputMode="numeric" />
              <p className="text-xs text-muted-foreground">{amount > 0 ? `${amount.toLocaleString("vi-VN")} đ` : "Phải lớn hơn 0"}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dps-note">Nội dung chuyển khoản</Label>
              <Input id="dps-note" value={form.transfer_note_template} onChange={set("transfer_note_template")} />
              <p className="text-xs text-muted-foreground">Giữ {"{application_code}"}: hệ thống thay bằng mã hồ sơ.</p>
            </div>
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>Đóng</Button>
          <Button disabled={!valid || save.isPending || settings.isLoading} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
