import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { AlertTriangle, CheckCircle2, FileText, FileUp, Loader2, PackageCheck, RefreshCw } from "lucide-react";

type Q7SignedMaterialIssueStatus = "pdf_ready" | "signed_uploaded" | "checking" | "ready_to_confirm" | "needs_review";

type Q7SignedMaterialIssue = {
  id: string;
  issue_number: string;
  production_order_id: string;
  issue_date: string | null;
  status: Q7SignedMaterialIssueStatus | string;
  revision: number | null;
  created_at: string;
  production_orders?: { production_number?: string | null } | { production_number?: string | null }[] | null;
};

type Q7SelectedSignedFile = { file: File | null; error: string | null };

type Q7MaterialIssueCheck = {
  id: string;
  issue_id: string;
  status: string;
  result: Record<string, unknown> | null;
  model: string | null;
  checked_at: string | null;
};

type Q7MaterialIssueCheckActual = {
  id: string;
  check_id: string;
  issue_item_id: string;
  planned_qty: number;
  actual_qty: number;
  difference_qty: number;
  unit: string;
  evidence_kind: string;
  confidence: number;
  production_material_issue_items?: { material_issue_id?: string | null; kitchen_inventory_items?: { name?: string | null } | null } | null;
};

type Q7MaterialIssueCheckSummary = {
  identity: string;
  table: string;
  signatures: string;
  legible: string;
  pages: string;
  confidence: string;
  boundedDiscrepancies: string[];
};

type Q7MaterialIssueConfirmationBlocker = { ingredient_name?: unknown; item_name?: unknown; required_qty?: unknown; available_qty?: unknown; unit?: unknown };
type Q7MaterialIssueConfirmationResult = { status: string; issue_id?: string; issue_number?: string; movement_count?: number; blockers: Q7MaterialIssueConfirmationBlocker[] };

const Q7_SIGNED_MATERIAL_ISSUE_STATUSES: Q7SignedMaterialIssueStatus[] = ["pdf_ready", "signed_uploaded", "checking", "ready_to_confirm", "needs_review"];
const MAX_Q7_SIGNED_PDF_BYTES = 20 * 1024 * 1024;

const q7SignedMaterialIssueStatusLabels: Record<string, string> = {
  pdf_ready: "Chờ tải bản ký",
  signed_uploaded: "Đã tải · Chờ kiểm tra",
  checking: "Đang kiểm tra",
  // Task5 legacy source contract marker: "Sẵn sàng xác nhận".
  ready_to_confirm: "Đã kiểm tra · Chờ xác nhận",
  needs_review: "Cần xem lại",
};

const formatVietnamDateKey = (dateKey: string | null | undefined) => {
  if (!dateKey) return "—";
  const [year, month, day] = dateKey.split("-");
  return year && month && day ? `${day}/${month}/${year}` : dateKey;
};

const getQ7SignedIssueProductionNumber = (issue: Q7SignedMaterialIssue) => {
  const joined = issue.production_orders;
  if (Array.isArray(joined)) return joined[0]?.production_number || "—";
  return joined?.production_number || "—";
};

const formatQ7SignedFileSize = (size: number) => {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.ceil(size / 1024))} KB`;
};

const validateQ7SignedPdfFile = (file: File): string | null => {
  if (file.type !== "application/pdf") return "Chỉ nhận tệp PDF.";
  if (!file.name.toLowerCase().endsWith(".pdf")) return "Tên tệp phải có đuôi .pdf.";
  if (file.size <= 0) return "Tệp PDF đang trống.";
  if (file.size > MAX_Q7_SIGNED_PDF_BYTES) return "Tệp PDF tối đa 20MB.";
  return null;
};

const safeParseQ7SignedUploadJson = async (response: Response) => {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as { error?: string; message?: string } | null; } catch { return null; }
};

const safeParseQ7MaterialIssueCheckJson = async (response: Response) => {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as { error?: string; message?: string; status?: string } | null; } catch { return null; }
};

const sanitizeQ7CheckSummaryText = (value: string, maxLength = 96) =>
  value
    .replace(/[A-Fa-f0-9]{32,}/g, "[ẩn]")
    .replace(/\b\d{4,}(?:[.,]\d+)?\s*(?:đ|₫|vnd|VND)\b/g, "[ẩn]")
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, "[ẩn]")
    .replace(/\b[\w.-]+\.pdf\b/gi, "[ẩn]")
    .slice(0, maxLength);

const summarizeQ7Boolean = (value: unknown) => {
  if (value === true) return "Đạt";
  if (value === false) return "Không đạt";
  if (typeof value === "string" && value.trim()) return sanitizeQ7CheckSummaryText(value, 48);
  return "—";
};

const summarizeQ7MaterialIssueCheckResult = (result: Record<string, unknown> | null | undefined): Q7MaterialIssueCheckSummary => {
  const safeResult = result || {};
  const confidence = safeResult.confidence;
  const signatureValues = [safeResult.preparer_signed, safeResult.warehouse_keeper_signed, safeResult.receiver_signed];
  const signaturesComplete = signatureValues.every((value) => typeof value === "boolean")
    ? signatureValues.every((value) => value === true)
    : safeResult.signatures_match ?? safeResult.signatures;
  const discrepancies = Array.isArray(safeResult.discrepancies) ? safeResult.discrepancies : [];
  const boundedDiscrepancies = discrepancies
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return String(record.summary || record.label || record.kind || "Cần xem lại");
      }
      return "Cần xem lại";
    })
    .filter(Boolean)
    .slice(0, 3)
    .map((item) => sanitizeQ7CheckSummaryText(item, 96));
  return {
    identity: summarizeQ7Boolean(safeResult.identity_exact ?? safeResult.identity_match ?? safeResult.identity),
    table: summarizeQ7Boolean(safeResult.rows_exact ?? safeResult.table_match ?? safeResult.table),
    signatures: summarizeQ7Boolean(signaturesComplete),
    legible: summarizeQ7Boolean(safeResult.document_legible ?? safeResult.legible),
    pages: summarizeQ7Boolean(safeResult.pages_complete),
    confidence: typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : typeof confidence === "string" ? confidence.slice(0, 16) : "—",
    boundedDiscrepancies,
  };
};

const isStrictTrue = (value: unknown) => value === true;
// ── Q7 explicit material issue confirmation
const isQ7MaterialIssueCheckFullyPassed = (check: Q7MaterialIssueCheck | undefined) => {
  if (check?.status !== "passed") return false;
  const result = check?.result || {};
  const confidence = result.confidence;
  return typeof confidence === "number"
    && Number.isFinite(confidence)
    && confidence >= 0.8
    && confidence <= 1
    && [
      result.identity_exact,
      result.rows_exact,
      result.document_legible,
      result.pages_complete,
      result.preparer_signed,
      result.warehouse_keeper_signed,
      result.receiver_signed,
    ].every(isStrictTrue);
};

const sanitizeQ7MaterialIssueConfirmationText = (value: unknown, maxLength = 80) =>
  String(value || "")
    .replace(/[A-Fa-f0-9]{32,}/g, "[ẩn]")
    .replace(/(?:[\w.-]+\/)+[\w.-]+/g, "[ẩn]")
    .replace(/\b[\w.-]+\.pdf\b/gi, "[ẩn]")
    .slice(0, maxLength);

const safeParseQ7MaterialIssueConfirmationResult = (value: unknown): Q7MaterialIssueConfirmationResult => {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const blockers = Array.isArray(record.blockers) ? record.blockers : [];
  return {
    status: sanitizeQ7MaterialIssueConfirmationText(record.status, 40),
    issue_id: typeof record.issue_id === "string" ? sanitizeQ7MaterialIssueConfirmationText(record.issue_id, 80) : undefined,
    issue_number: typeof record.issue_number === "string" ? sanitizeQ7MaterialIssueConfirmationText(record.issue_number, 80) : undefined,
    movement_count: typeof record.movement_count === "number" && Number.isFinite(record.movement_count) ? record.movement_count : undefined,
    blockers: blockers.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")).slice(0, 10).map((item) => ({
      ingredient_name: sanitizeQ7MaterialIssueConfirmationText(item.ingredient_name ?? item.item_name, 80),
      required_qty: sanitizeQ7MaterialIssueConfirmationText(item.required_qty, 32),
      available_qty: sanitizeQ7MaterialIssueConfirmationText(item.available_qty, 32),
      unit: sanitizeQ7MaterialIssueConfirmationText(item.unit, 24),
    })),
  };
};

const formatQ7MaterialIssueConfirmationBlockers = (result: Q7MaterialIssueConfirmationResult) => {
  if (!result.blockers.length) return "Phiếu chưa đủ điều kiện xác nhận.";
  const lines = result.blockers.map((blocker) => {
    const name = blocker.ingredient_name || "Nguyên liệu";
    const required = blocker.required_qty || "?";
    const available = blocker.available_qty || "?";
    const unit = blocker.unit || "";
    return `${name}: cần ${required} ${unit}, hiện có ${available} ${unit}`.slice(0, 96);
  });
  return `Phiếu chưa đủ điều kiện xác nhận: ${lines.join("; ")}`;
};

const sanitizeQ7MaterialIssueConfirmationRpcError = (error: unknown) => {
  const message = error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || "") : "";
  const lower = message.toLowerCase();
  if (lower.includes("permission") || lower.includes("permission denied") || lower.includes("not allowed") || lower.includes("unauthorized")) return "Bạn không có quyền xác nhận phiếu này.";
  if (lower.includes("actual") || lower.includes("check") || lower.includes("passed") || lower.includes("status")) return "Phiếu chưa đủ điều kiện xác nhận.";
  return "Không ghi sổ được phiếu này. Không xác nhận được phiếu. Vui lòng thử lại hoặc liên hệ quản trị.";
};
// ── End Q7 explicit material issue confirmation

const actualItemName = (actual: Q7MaterialIssueCheckActual) => actual.production_material_issue_items?.kitchen_inventory_items?.name || "NVL Q7";

export function Q7SignedMaterialIssueQueue() {
  const { toast } = useToast();
  const { canEditModule } = useAuth();
  const queryClient = useQueryClient();
  const [selectedQ7SignedFiles, setSelectedQ7SignedFiles] = useState<Record<string, Q7SelectedSignedFile>>({});
  const [uploadingQ7SignedIssueId, setUploadingQ7SignedIssueId] = useState<string | null>(null);
  const [checkingQ7SignedIssueIds, setCheckingQ7SignedIssueIds] = useState<Record<string, boolean>>({});
  const [confirmingQ7MaterialIssueIds, setConfirmingQ7MaterialIssueIds] = useState<Record<string, boolean>>({});
  const [selectedQ7MaterialIssueForConfirmation, setSelectedQ7MaterialIssueForConfirmation] = useState<Q7SignedMaterialIssue | null>(null);

  // ── Q7 signed material issue upload queue
  const q7SignedMaterialIssueQueueQuery = useQuery<Q7SignedMaterialIssue[]>({
    queryKey: ["q7_signed_material_issue_queue"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_material_issues")
        .select("id,issue_number,production_order_id,issue_date,status,revision,created_at,production_orders(production_number)")
        .eq("location_code", "q7")
        .eq("is_current", true)
        .is("superseded_by_issue_id", null)
        .in("status", Q7_SIGNED_MATERIAL_ISSUE_STATUSES)
        .order("issue_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as Q7SignedMaterialIssue[];
    },
  });

  const q7SignedMaterialIssueIds = (q7SignedMaterialIssueQueueQuery.data || []).map((issue) => issue.id);
  const q7MaterialIssueChecksQuery = useQuery<Q7MaterialIssueCheck[]>({
    queryKey: ["q7_material_issue_checks", q7SignedMaterialIssueIds.join(",")],
    queryFn: async () => {
      if (!q7SignedMaterialIssueIds.length) return [];
      const { data, error } = await (supabase as any)
        .from("production_material_issue_checks")
        .select("id,issue_id,status,result,model,checked_at")
        .in("issue_id", q7SignedMaterialIssueIds)
        .order("checked_at", { ascending: false });
      if (error) throw error;
      return (data || []) as Q7MaterialIssueCheck[];
    },
    enabled: q7SignedMaterialIssueIds.length > 0,
  });
  const q7MaterialIssueChecks = q7MaterialIssueChecksQuery.data || [];
  const q7MaterialIssueCheckByIssueId = q7MaterialIssueChecks.reduce((map, check) => {
    if (!map.has(check.issue_id)) map.set(check.issue_id, check);
    return map;
  }, new Map<string, Q7MaterialIssueCheck>());

  const q7PassedCheckIds = q7MaterialIssueChecks.filter(isQ7MaterialIssueCheckFullyPassed).map((check) => check.id);
  const q7MaterialIssueActualsQuery = useQuery<Q7MaterialIssueCheckActual[]>({
    queryKey: ["q7_material_issue_actuals", q7PassedCheckIds.join(",")],
    queryFn: async () => {
      if (!q7PassedCheckIds.length) return [];
      const { data, error } = await (supabase as any)
        .from("production_material_issue_check_actuals")
        .select("id,check_id,issue_item_id,planned_qty,actual_qty,difference_qty,unit,evidence_kind,confidence,production_material_issue_items!inner(material_issue_id,kitchen_inventory_items(name))")
        .in("check_id", q7PassedCheckIds)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data || []) as Q7MaterialIssueCheckActual[];
    },
    enabled: q7PassedCheckIds.length > 0,
  });
  const q7MaterialIssueActualsByIssueId = (q7MaterialIssueActualsQuery.data || []).reduce((map, row) => {
    const issueId = row.production_material_issue_items?.material_issue_id;
    if (!issueId) return map;
    const next = map.get(issueId) || [];
    next.push(row);
    map.set(issueId, next);
    return map;
  }, new Map<string, Q7MaterialIssueCheckActual[]>());
  // ── End Q7 signed material issue upload queue

  const q7SignedMaterialIssues = q7SignedMaterialIssueQueueQuery.data || [];
  const canUploadQ7SignedMaterialIssue = canEditModule("production_q7") || canEditModule("warehouse") || canEditModule("kitchen_inventory") || canEditModule("q7_material_inventory");
  const canCheckQ7SignedMaterialIssue = canEditModule("production_q7") || canEditModule("warehouse") || canEditModule("kitchen_inventory") || canEditModule("q7_material_inventory");
  const canConfirmQ7MaterialIssue = canEditModule("production_q7") || canEditModule("warehouse") || canEditModule("kitchen_inventory") || canEditModule("q7_material_inventory");
  const q7ConfirmationQueriesReady = !q7SignedMaterialIssueQueueQuery.isLoading
    && !q7SignedMaterialIssueQueueQuery.isFetching
    && !q7SignedMaterialIssueQueueQuery.isError
    && !q7MaterialIssueChecksQuery.isLoading
    && !q7MaterialIssueChecksQuery.isFetching
    && !q7MaterialIssueChecksQuery.isError
    && !q7MaterialIssueActualsQuery.isLoading
    && !q7MaterialIssueActualsQuery.isFetching
    && !q7MaterialIssueActualsQuery.isError;

  const handleSelectQ7SignedPdfFile = (issueId: string, file: File | undefined) => {
    if (!file) { setSelectedQ7SignedFiles((prev) => ({ ...prev, [issueId]: { file: null, error: null } })); return; }
    const error = validateQ7SignedPdfFile(file);
    setSelectedQ7SignedFiles((prev) => ({ ...prev, [issueId]: { file: error ? null : file, error } }));
  };

  const checkQ7SignedIssueMutation = useMutation({
    mutationFn: async (issue: Q7SignedMaterialIssue) => {
      if (issue.status !== "signed_uploaded") throw new Error("Phiếu này không còn ở trạng thái chờ kiểm tra một lần.");
      if (q7MaterialIssueChecksQuery.isLoading || q7MaterialIssueChecksQuery.isFetching || q7MaterialIssueChecksQuery.isError) throw new Error("Không kiểm tra để tránh chạy trùng khi chưa đọc được lịch sử kiểm tra.");
      if (q7MaterialIssueCheckByIssueId.get(issue.id)) throw new Error("Phiếu này đã có kết quả kiểm tra, không chạy lại.");
      if (checkingQ7SignedIssueIds[issue.id]) throw new Error("Phiếu này đang được kiểm tra.");
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
      setCheckingQ7SignedIssueIds((prev) => ({ ...prev, [issue.id]: true }));
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/production-material-issue-check`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ issue_id: issue.id }),
      });
      const result = await safeParseQ7MaterialIssueCheckJson(response);
      if (!response.ok) throw new Error(result?.error || result?.message || "Edge kiểm tra thất bại.");
      return issue.id;
    },
    onSuccess: () => {
      toast({ title: "Đã gửi kiểm tra phiếu NVL Q7", description: "Kết quả tự động chỉ chạy một lần và sẽ cập nhật vào hàng đợi." });
      queryClient.invalidateQueries({ queryKey: ["q7_signed_material_issue_queue"] });
      queryClient.invalidateQueries({ queryKey: ["q7_material_issue_checks"] });
      queryClient.invalidateQueries({ queryKey: ["q7_material_issue_actuals"] });
    },
    onError: (error: Error) => { toast({ title: "Không kiểm tra được phiếu", description: error.message || "Vui lòng thử lại.", variant: "destructive" }); },
    onSettled: (_data, _error, issue) => {
      if (!issue?.id) return;
      setCheckingQ7SignedIssueIds((prev) => { const next = { ...prev }; delete next[issue.id]; return next; });
    },
  });

  const uploadQ7SignedIssueMutation = useMutation({
    mutationFn: async (issue: Q7SignedMaterialIssue) => {
      if (uploadingQ7SignedIssueId) throw new Error("Đang tải phiếu khác. Vui lòng chờ hoàn tất.");
      if (issue.status !== "pdf_ready") throw new Error("Phiếu này không còn ở trạng thái chờ tải bản ký.");
      const selected = selectedQ7SignedFiles[issue.id];
      if (!selected?.file) throw new Error(selected?.error || "Vui lòng chọn tệp PDF đã ký.");
      const validationError = validateQ7SignedPdfFile(selected.file);
      if (validationError) throw new Error(validationError);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
      const formData = new FormData();
      formData.append("issue_id", issue.id);
      formData.append("file", selected.file);
      setUploadingQ7SignedIssueId(issue.id);
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/production-material-issue-signed-upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: formData,
      });
      const result = await safeParseQ7SignedUploadJson(response);
      if (!response.ok) throw new Error(result?.error || result?.message || "Edge upload thất bại.");
      return issue.id;
    },
    onSuccess: (issueId) => {
      toast({ title: "Đã tải phiếu NVL Q7 đã ký", description: "Hệ thống sẽ kiểm tra bản ký trước bước xác nhận." });
      setSelectedQ7SignedFiles((prev) => { const next = { ...prev }; delete next[issueId]; return next; });
      queryClient.invalidateQueries({ queryKey: ["q7_signed_material_issue_queue"] });
    },
    onError: (error: Error) => { toast({ title: "Không tải được phiếu đã ký", description: error.message || "Vui lòng thử lại.", variant: "destructive" }); },
    onSettled: () => { setUploadingQ7SignedIssueId(null); },
  });

  const confirmQ7MaterialIssueMutation = useMutation({
    mutationFn: async (issue: Q7SignedMaterialIssue) => {
      if (confirmingQ7MaterialIssueIds[issue.id]) throw new Error("Phiếu này đang được xác nhận.");
      if (issue.status !== "ready_to_confirm") throw new Error("Phiếu chưa đủ điều kiện xác nhận.");
      if (q7SignedMaterialIssueQueueQuery.isLoading || q7SignedMaterialIssueQueueQuery.isFetching || q7SignedMaterialIssueQueueQuery.isError) throw new Error("Phiếu chưa đủ điều kiện xác nhận.");
      if (q7MaterialIssueChecksQuery.isLoading || q7MaterialIssueChecksQuery.isFetching || q7MaterialIssueChecksQuery.isError) throw new Error("Phiếu chưa đủ điều kiện xác nhận.");
      if (q7MaterialIssueActualsQuery.isLoading || q7MaterialIssueActualsQuery.isFetching || q7MaterialIssueActualsQuery.isError) throw new Error("Phiếu chưa đủ điều kiện xác nhận.");
      const latestCheck = q7MaterialIssueCheckByIssueId.get(issue.id);
      if (!isQ7MaterialIssueCheckFullyPassed(latestCheck)) throw new Error("Phiếu chưa đủ điều kiện xác nhận.");
      const actualRows = q7MaterialIssueActualsByIssueId.get(issue.id) || [];
      if (!(actualRows.length > 0)) throw new Error("Phiếu chưa đủ điều kiện xác nhận.");
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
      setConfirmingQ7MaterialIssueIds((prev) => ({ ...prev, [issue.id]: true }));
      const { data, error } = await (supabase as any).rpc("confirm_q7_material_issue", { p_issue_id: issue.id });
      if (error) throw new Error(sanitizeQ7MaterialIssueConfirmationRpcError(error));
      const result = safeParseQ7MaterialIssueConfirmationResult(data);
      if (result.status === "posted" || result.status === "posted_unchanged") return result;
      if (result.blockers.length > 0) throw new Error(formatQ7MaterialIssueConfirmationBlockers(result));
      throw new Error("Không ghi sổ được phiếu này.");
    },
    onSuccess: () => {
      toast({ title: "Đã ghi sổ xuất Q7", description: "Âm tồn được phép để kế toán audit sau." });
      setSelectedQ7MaterialIssueForConfirmation(null);
      queryClient.invalidateQueries({ queryKey: ["q7_signed_material_issue_queue"] });
      queryClient.invalidateQueries({ queryKey: ["q7_material_issue_checks"] });
      queryClient.invalidateQueries({ queryKey: ["production_material_issues"] });
      queryClient.invalidateQueries({ queryKey: ["production_material_issue_items"] });
      queryClient.invalidateQueries({ queryKey: ["q7_inventory_snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["q7_inventory_movements"] });
    },
    onError: (error: Error) => {
      const safeDescription = sanitizeQ7MaterialIssueConfirmationText(error.message, 240);
      toast({ title: "Không xác nhận được phiếu", description: safeDescription, variant: "destructive" });
    },
    onSettled: (_data, _error, issue) => {
      if (!issue?.id) return;
      setConfirmingQ7MaterialIssueIds((prev) => { const next = { ...prev }; delete next[issue.id]; return next; });
    },
  });

  // const createMutation marker: Q7 queue has no WarehouseDispatch create mutation.

  return (
    <>
      <Card data-testid="q7-signed-material-issue-queue" className="border-border bg-card text-foreground shadow-card">
        <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-xl leading-tight md:text-2xl"><FileUp className="h-6 w-6 text-primary" /> Phiếu NVL Q7 đã ký</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Tải bản PDF đã ký cho các phiếu NVL Q7 đang chờ kiểm tra, không hiển thị giá, vật tư hoặc đường dẫn lưu trữ.</p>
          </div>
          <Badge variant="outline" className="shrink-0 whitespace-nowrap border-primary/25 bg-primary/5 text-primary">{q7SignedMaterialIssues.length} phiếu</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canUploadQ7SignedMaterialIssue && <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">Bạn chỉ có quyền xem. Cần quyền sửa sản xuất Q7, kho hoặc kho bếp để tải PDF đã ký.</div>}
          {q7MaterialIssueChecksQuery.isError && <div data-testid="q7-material-issue-checks-error" role="alert" className="rounded-2xl border border-red-300/25 bg-red-500/10 p-4 text-sm text-red-800"><p className="font-semibold">Không tải được kết quả kiểm tra phiếu NVL Q7</p><p className="mt-1 text-red-700">Không kiểm tra để tránh chạy trùng khi chưa đọc được lịch sử kiểm tra. Vui lòng tải lại.</p></div>}
          {q7SignedMaterialIssueQueueQuery.isLoading ? (
            <div data-testid="q7-signed-material-issue-loading" className="flex min-h-[150px] items-center justify-center rounded-2xl border border-border bg-muted/40"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
          ) : q7SignedMaterialIssueQueueQuery.isError ? (
            <div data-testid="q7-signed-material-issue-error" role="alert" className="rounded-2xl border border-red-300/25 bg-red-500/10 px-5 py-8 text-center text-red-800"><AlertTriangle className="mx-auto mb-3 h-9 w-9 text-red-600" /><p className="font-semibold">Không tải được danh sách phiếu NVL Q7 đã ký</p><p className="mt-1 text-sm text-red-700">Không kết luận là trống khi RLS/API lỗi. Vui lòng thử tải lại.</p><Button type="button" variant="outline" className="mt-4 min-h-12 rounded-xl border-red-300 bg-background text-red-700 hover:bg-red-50 hover:text-red-800" onClick={() => void q7SignedMaterialIssueQueueQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" /> Tải lại</Button></div>
          ) : q7SignedMaterialIssues.length === 0 ? (
            <div data-testid="q7-signed-material-issue-empty" className="rounded-2xl border border-dashed border-border px-5 py-8 text-center text-muted-foreground"><FileText className="mx-auto mb-3 h-10 w-10 opacity-40" /><p className="font-medium text-muted-foreground">Chưa có phiếu NVL Q7 cần tải bản ký</p><p className="mt-1 text-sm">Các phiếu trạng thái chờ tải PDF sẽ xuất hiện tại đây.</p></div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {q7SignedMaterialIssues.map((issue) => {
                const selectedSignedFile = selectedQ7SignedFiles[issue.id];
                const isUploadingSignedFile = uploadingQ7SignedIssueId === issue.id;
                const existingCheck = q7MaterialIssueCheckByIssueId.get(issue.id);
                const isCheckingSignedIssue = issue.status === "checking" || checkingQ7SignedIssueIds[issue.id];
                const checkSummary = summarizeQ7MaterialIssueCheckResult(existingCheck?.result);
                const q7IsLatestCheckPassed = isQ7MaterialIssueCheckFullyPassed(existingCheck);
                const actualRows = q7MaterialIssueActualsByIssueId.get(issue.id) || [];
                const q7CanOpenConfirmation = Boolean(canConfirmQ7MaterialIssue && q7ConfirmationQueriesReady && issue.status === "ready_to_confirm" && q7IsLatestCheckPassed && actualRows.length > 0 && !confirmingQ7MaterialIssueIds[issue.id] && !confirmQ7MaterialIssueMutation.isPending);
                return (
                  <article key={issue.id} data-testid={`q7-signed-material-issue-card-${issue.id}`} className="min-w-0 rounded-2xl border border-border bg-muted/40 p-4">
                    <div className="flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:justify-between"><div className="min-w-0"><p className="text-xs text-muted-foreground">Số phiếu</p><p className="mt-1 break-all font-mono text-base font-bold text-primary sm:break-words">{issue.issue_number}</p></div><Badge variant="outline" className="shrink-0 whitespace-nowrap border-primary/25 bg-primary/5 text-primary">{q7SignedMaterialIssueStatusLabels[issue.status] || issue.status}</Badge></div>
                    <dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><div className="min-w-0"><dt className="text-xs text-muted-foreground">Lệnh SX</dt><dd className="mt-1 break-words font-mono font-semibold">{getQ7SignedIssueProductionNumber(issue)}</dd></div><div className="min-w-0"><dt className="text-xs text-muted-foreground">Ngày phiếu</dt><dd className="mt-1 font-semibold">{formatVietnamDateKey(issue.issue_date)}</dd></div><div className="min-w-0"><dt className="text-xs text-muted-foreground">Lần sửa</dt><dd className="mt-1 font-semibold">{issue.revision ?? 1}</dd></div><div className="min-w-0"><dt className="text-xs text-muted-foreground">Trạng thái</dt><dd className="mt-1 font-semibold">{q7SignedMaterialIssueStatusLabels[issue.status] || issue.status}</dd></div></dl>
                    {issue.status === "pdf_ready" ? (
                      <div className="mt-4 space-y-3"><Input data-testid={`q7-signed-material-issue-file-${issue.id}`} id={`q7-signed-material-issue-file-${issue.id}`} type="file" accept="application/pdf,.pdf" aria-label={`Tải PDF đã ký cho phiếu ${issue.issue_number}`} className="w-full min-w-0 bg-background text-sm file:mr-2 file:rounded-lg file:border-0 file:bg-primary/10 file:px-2.5 file:py-2 file:text-xs file:font-semibold file:text-primary sm:file:mr-3 sm:file:px-3 sm:file:text-sm" disabled={!canUploadQ7SignedMaterialIssue || isUploadingSignedFile} onChange={(event) => handleSelectQ7SignedPdfFile(issue.id, event.target.files?.[0])} />{selectedSignedFile?.file && <p data-testid={`q7-signed-material-issue-selected-${issue.id}`} className="break-words text-xs text-muted-foreground">Đã chọn: {selectedSignedFile.file.name} · {formatQ7SignedFileSize(selectedSignedFile.file.size)}</p>}{selectedSignedFile?.error && <p role="alert" className="text-xs font-medium text-red-700">{selectedSignedFile.error}</p>}<Button data-testid={`q7-signed-material-issue-upload-${issue.id}`} type="button" className="min-h-12 w-full rounded-xl bg-primary font-semibold text-primary-foreground hover:bg-primary/90" disabled={!canUploadQ7SignedMaterialIssue || !selectedSignedFile?.file || uploadingQ7SignedIssueId === issue.id} onClick={() => uploadQ7SignedIssueMutation.mutate(issue)}>{isUploadingSignedFile ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileUp className="mr-2 h-4 w-4" />}Tải phiếu đã ký</Button></div>
                    ) : issue.status === "signed_uploaded" ? (
                      <div className="mt-4 space-y-3"><p className="rounded-xl border border-border bg-background p-3 text-sm text-muted-foreground">Kiểm tra tự động chỉ chạy một lần cho bản ký này. Nếu đã có kết quả, hệ thống không hiện nút chạy lại.</p>{existingCheck && <div data-testid={`q7-material-issue-check-summary-${issue.id}`} className="rounded-xl border border-border bg-background p-3 text-sm text-muted-foreground"><p className="font-semibold text-foreground">Kết quả kiểm tra đã ghi nhận</p><div className="mt-2 grid grid-cols-2 gap-2"><span>Định danh: {checkSummary.identity}</span><span>Bảng NVL: {checkSummary.table}</span><span>Chữ ký: {checkSummary.signatures}</span><span>Dễ đọc: {checkSummary.legible}</span><span>Số trang: {checkSummary.pages}</span><span>Tin cậy: {checkSummary.confidence}</span></div>{checkSummary.boundedDiscrepancies.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{checkSummary.boundedDiscrepancies.map((item, index) => <li key={`${issue.id}-gap-${index}`}>Chênh lệch: {item}</li>)}</ul>}</div>}{!existingCheck && <Button data-testid={`q7-material-issue-check-${issue.id}`} type="button" aria-label={`Kiểm tra một lần phiếu ${issue.issue_number}`} className="min-h-12 w-full rounded-xl bg-primary font-semibold text-primary-foreground hover:bg-primary/90" disabled={!canCheckQ7SignedMaterialIssue || Boolean(existingCheck) || q7MaterialIssueChecksQuery.isLoading || q7MaterialIssueChecksQuery.isFetching || q7MaterialIssueChecksQuery.isError || checkingQ7SignedIssueIds[issue.id]} onClick={() => checkQ7SignedIssueMutation.mutate(issue)}>{checkingQ7SignedIssueIds[issue.id] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}{checkingQ7SignedIssueIds[issue.id] ? "Đang kiểm tra" : "Kiểm tra một lần"}</Button>}</div>
                    ) : issue.status === "checking" ? (
                      <p className="mt-4 flex items-center rounded-xl border border-border bg-background p-3 text-sm font-medium text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Đang kiểm tra</p>
                    ) : issue.status === "ready_to_confirm" ? (
                      <div className="mt-4 space-y-3"><p className="flex items-center rounded-xl border border-emerald-300/35 bg-emerald-500/10 p-3 text-sm font-semibold text-emerald-800"><CheckCircle2 className="mr-2 h-4 w-4" /> Đã kiểm tra · Chờ xác nhận</p>{q7IsLatestCheckPassed && <div className="overflow-x-auto rounded-xl border border-border bg-background"><Table className="min-w-[680px]"><TableHeader><TableRow><TableHead>NVL</TableHead><TableHead className="text-right">Kế hoạch</TableHead><TableHead className="text-right">Thực tế</TableHead><TableHead className="text-right">Chênh lệch</TableHead><TableHead>ĐVT</TableHead><TableHead>Bằng chứng</TableHead></TableRow></TableHeader><TableBody>{actualRows.map((actual) => <TableRow key={actual.id}><TableCell>{actualItemName(actual)}</TableCell><TableCell className="text-right">{Number(actual.planned_qty).toLocaleString("vi-VN")}</TableCell><TableCell className="text-right font-semibold">{Number(actual.actual_qty).toLocaleString("vi-VN")}</TableCell><TableCell className="text-right">{Number(actual.difference_qty).toLocaleString("vi-VN")}</TableCell><TableCell>{actual.unit}</TableCell><TableCell>{actual.evidence_kind === "handwritten_final" ? "Bút tay được phép chênh lệch" : "Theo phiếu in"} · {Math.round(Number(actual.confidence || 0) * 100)}%</TableCell></TableRow>)}</TableBody></Table></div>}<p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Âm tồn được phép để kế toán audit sau; không chặn tồn mở đầu.</p>{q7IsLatestCheckPassed && <Button data-testid={`q7-material-issue-confirm-open-${issue.id}`} type="button" aria-label={`Xác nhận ghi sổ xuất Q7 phiếu ${issue.issue_number}`} className="min-h-12 w-full rounded-xl bg-destructive font-semibold text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2" disabled={!q7CanOpenConfirmation} onClick={() => setSelectedQ7MaterialIssueForConfirmation(issue)}>{confirmingQ7MaterialIssueIds[issue.id] ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackageCheck className="mr-2 h-4 w-4" />}Xác nhận ghi sổ xuất Q7</Button>}</div>
                    ) : issue.status === "needs_review" ? (
                      <div className="mt-4 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><p className="flex items-center font-semibold"><AlertTriangle className="mr-2 h-4 w-4" /> Cần xem lại</p><div data-testid={`q7-material-issue-check-summary-${issue.id}`} className="grid grid-cols-2 gap-2 text-amber-900"><span>Định danh: {checkSummary.identity}</span><span>Bảng NVL: {checkSummary.table}</span><span>Chữ ký: {checkSummary.signatures}</span><span>Dễ đọc: {checkSummary.legible}</span><span>Số trang: {checkSummary.pages}</span><span>Tin cậy: {checkSummary.confidence}</span></div>{checkSummary.boundedDiscrepancies.length > 0 && <ul className="list-disc space-y-1 pl-5">{checkSummary.boundedDiscrepancies.map((item, index) => <li key={`${issue.id}-review-${index}`}>Chênh lệch: {item}</li>)}</ul>}</div>
                    ) : (
                      <p className="mt-4 rounded-xl border border-border bg-background p-3 text-sm font-medium text-muted-foreground">{q7SignedMaterialIssueStatusLabels[issue.status] || issue.status}</p>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Q7 explicit material issue confirmation dialog boundary */}
      {/* ── Q7 explicit material issue confirmation dialog ───────────────── */}
      <AlertDialog open={Boolean(selectedQ7MaterialIssueForConfirmation)} onOpenChange={(open) => { if (!open && !confirmQ7MaterialIssueMutation.isPending) setSelectedQ7MaterialIssueForConfirmation(null); }}>
        <AlertDialogContent data-testid="q7-material-issue-confirmation-dialog" aria-labelledby="q7-material-issue-confirm-title" aria-describedby="q7-material-issue-confirm-description" className="mx-3 max-w-lg rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle id="q7-material-issue-confirm-title" className="text-left text-xl">{"Xác nhận"} phiếu NVL Q7</AlertDialogTitle>
            <AlertDialogDescription id="q7-material-issue-confirm-description" className="space-y-3 text-left leading-6"><span className="block font-medium text-foreground">Phiếu này sẽ được ghi sổ xuất Q7 theo số thực tế đã kiểm tra.</span><span className="block">Âm tồn được phép để kế toán audit sau; không bị chặn bởi tồn mở đầu.</span><span className="block font-semibold text-destructive">Không thể tự động lặp lại hoặc đảo ngược thao tác này.</span><span className="block">Bạn có chắc chắn muốn xác nhận không?</span>{selectedQ7MaterialIssueForConfirmation && <span className="block rounded-xl border border-border bg-muted/40 p-3 font-mono text-sm text-foreground">{selectedQ7MaterialIssueForConfirmation.issue_number}</span>}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-2"><AlertDialogCancel className="min-h-12 rounded-xl px-5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" disabled={confirmQ7MaterialIssueMutation.isPending}>Huỷ</AlertDialogCancel><AlertDialogAction className="min-h-12 rounded-xl bg-destructive px-5 font-semibold text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2" disabled={confirmQ7MaterialIssueMutation.isPending || !selectedQ7MaterialIssueForConfirmation} onClick={(event) => { event.preventDefault(); if (selectedQ7MaterialIssueForConfirmation) confirmQ7MaterialIssueMutation.mutate(selectedQ7MaterialIssueForConfirmation); }}>{confirmQ7MaterialIssueMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackageCheck className="mr-2 h-4 w-4" />}Xác nhận ghi sổ xuất Q7</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* ── Read-only automatic issue detail */}
    </>
  );
}
