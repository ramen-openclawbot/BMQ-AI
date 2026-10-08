// Supabase-backed implementation of the Bếp BN data source.
//
// The UI takes `useData: UseBepBnData` as a prop, so this hook can be swapped
// with the QA fixture without touching the panel. Reads and writes go through
// src/lib/payroll-bn/db-client.ts; every write invalidates the related queries.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  addAdjustment,
  createPeriod,
  deleteEmployeeContact,
  ensurePeriodForRows,
  fetchEmployeeContacts,
  fetchPublishedPayslipCount,
  importAttendance,
  listIssueReviews,
  listPeriods,
  loadPeriodData,
  loadPreviousCatalog,
  lockPeriod,
  publishPayslips as publishPayslipsRpc,
  setAttendanceApproved,
  upsertEmployee,
  upsertEmployeeContact,
  upsertIssueReview,
} from "@/lib/payroll-bn/db-client.ts";
import type { BepBnClient } from "@/lib/payroll-bn/db-client.ts";
import { suggestCatalogSync } from "@/lib/payroll-bn/catalog-sync.ts";
import { computePayroll } from "@/lib/payroll-bn/engine.ts";
import { buildPayslips } from "@/lib/payroll-bn/payslip.ts";
import { applyIssueReviews } from "@/lib/payroll-bn/issue-review.ts";
import { ADJUSTMENT_LABELS } from "@/components/payroll/bep-bn/format";
import type {
  BepBnAdjustmentInput,
  BepBnDataSource,
  BepBnImportFileResult,
  BepBnIssueReviewInput,
  BepBnPeriodData,
  BepBnPeriodInput,
  UseBepBnData,
} from "@/components/payroll/bep-bn/types";
import type { AttendanceRow, PayrollEmployee } from "@/lib/payroll-bn/types.ts";

const PERIODS_QUERY_KEY = ["payroll-bn", "periods"] as const;
const periodQueryKey = (periodId: string) => ["payroll-bn", "period", periodId] as const;
const previousEmployeesQueryKey = (periodId: string) =>
  ["payroll-bn", "previous-employees", periodId] as const;
const issueReviewsQueryKey = (periodId: string) => ["payroll-bn", "issue-reviews", periodId] as const;
const contactsQueryKey = ["payroll-bn", "contacts"] as const;
const publishedCountQueryKey = (periodId: string) =>
  ["payroll-bn", "published-count", periodId] as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Không tải được dữ liệu. Vui lòng thử lại.";
}

export const useBepBnData: UseBepBnData = (periodId) => {
  const queryClient = useQueryClient();
  // The generated Database type does not know the payroll_bn_* tables yet, so
  // the real client is cast once into the local shape used by db-client.
  const client = supabase as unknown as BepBnClient;

  const periodsQuery = useQuery({
    queryKey: PERIODS_QUERY_KEY,
    queryFn: () => listPeriods(client),
    staleTime: 30_000,
    retry: 1,
  });

  const dataQuery = useQuery({
    queryKey: periodQueryKey(periodId ?? "none"),
    queryFn: () => loadPeriodData(client, periodId as string),
    enabled: Boolean(periodId),
    staleTime: 15_000,
    retry: 1,
  });

  const previousEmployeesQuery = useQuery({
    queryKey: previousEmployeesQueryKey(periodId ?? "none"),
    queryFn: () => loadPreviousCatalog(client, periodId as string),
    enabled: Boolean(periodId),
    staleTime: 30_000,
    retry: 1,
  });

  const issueReviewsQuery = useQuery({
    queryKey: issueReviewsQueryKey(periodId ?? "none"),
    queryFn: () => listIssueReviews(client, periodId as string),
    enabled: Boolean(periodId),
    staleTime: 15_000,
    retry: 1,
  });

  const contactsQuery = useQuery({
    queryKey: contactsQueryKey,
    queryFn: () => fetchEmployeeContacts(client),
    staleTime: 30_000,
    retry: 1,
  });

  const publishedCountQuery = useQuery({
    queryKey: publishedCountQueryKey(periodId ?? "none"),
    queryFn: () => fetchPublishedPayslipCount(client, periodId as string),
    enabled: Boolean(periodId),
    staleTime: 15_000,
    retry: 1,
  });

  const invalidatePeriod = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ["payroll-bn", "period", id] });
  };
  const invalidatePeriods = () => {
    void queryClient.invalidateQueries({ queryKey: ["payroll-bn", "periods"] });
  };
  const invalidateReviews = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ["payroll-bn", "issue-reviews", id] });
  };
  const invalidatePreviousEmployees = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ["payroll-bn", "previous-employees", id] });
  };
  const invalidateContacts = () => {
    void queryClient.invalidateQueries({ queryKey: ["payroll-bn", "contacts"] });
  };
  const invalidatePublishedCount = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ["payroll-bn", "published-count", id] });
  };

  /**
   * Rebuild the published payload from exactly the data the draft uses:
   * load the period, run the same pure engine and format it with buildPayslips;
   * notes use the same "label: reason" text as the draft's Ghi chú column.
   */
  const computePublishPayload = async (id: string) => {
    const [periodData, reviews] = await Promise.all([
      loadPeriodData(client, id),
      listIssueReviews(client, id),
    ]);
    if (!periodData) throw new Error("Không tìm thấy kỳ lương.");
    // Same input as the draft table: attendance after the reviewer's "không tính" decisions.
    const result = computePayroll({
      period: periodData.period,
      employees: periodData.employees,
      measures: periodData.measures,
      rows: applyIssueReviews(periodData.rows, reviews),
      adjustments: periodData.adjustments,
    });
    const notes = new Map<string, string[]>();
    for (const item of periodData.adjustments) {
      notes.set(item.employeeCode, [
        ...(notes.get(item.employeeCode) ?? []),
        `${ADJUSTMENT_LABELS[item.field]}: ${item.reason}`,
      ]);
    }
    return buildPayslips(periodData.period, periodData.employees, result, notes);
  };

  const publishForPeriod = async (id: string): Promise<number> => {
    const payslips = await computePublishPayload(id);
    return publishPayslipsRpc(client, id, payslips);
  };

  const importMutation = useMutation({
    mutationFn: (input: {
      periodId: string;
      fileName: string;
      sha256: string;
      rows: AttendanceRow[];
    }) => importAttendance(client, input),
    onSuccess: (_result, input) => invalidatePeriod(input.periodId),
  });

  const importFileMutation = useMutation({
    mutationFn: async (input: {
      fileName: string;
      sha256: string;
      rows: AttendanceRow[];
    }): Promise<BepBnImportFileResult> => {
      const resolvedPeriodId = await ensurePeriodForRows(client, input.rows);
      const result = await importAttendance(client, {
        periodId: resolvedPeriodId,
        fileName: input.fileName,
        sha256: input.sha256,
        rows: input.rows,
      });

      const [periodData, previousEmployees] = await Promise.all([
        loadPeriodData(client, resolvedPeriodId),
        loadPreviousCatalog(client, resolvedPeriodId),
      ]);

      let addedEmployees = 0;
      if (periodData) {
        const { add } = suggestCatalogSync({
          period: periodData.period,
          rows: input.rows,
          employees: periodData.employees,
          previousEmployees,
        });
        for (const suggestion of add) {
          await upsertEmployee(client, resolvedPeriodId, suggestion.employee);
        }
        addedEmployees = add.length;
      }

      return {
        periodId: resolvedPeriodId,
        alreadyImported: result.alreadyImported,
        insertedRows: result.insertedRows,
        addedEmployees,
      };
    },
    onSuccess: (result) => {
      invalidatePeriods();
      invalidatePeriod(result.periodId);
      invalidatePreviousEmployees(result.periodId);
    },
  });

  const adjustmentMutation = useMutation({
    mutationFn: (variables: { periodId: string; input: BepBnAdjustmentInput }) =>
      addAdjustment(client, variables.periodId, variables.input),
    onSuccess: (_result, variables) => invalidatePeriod(variables.periodId),
  });

  const reviewMutation = useMutation({
    mutationFn: (variables: { periodId: string; input: BepBnIssueReviewInput }) =>
      upsertIssueReview(client, variables.periodId, variables.input),
    onSuccess: (_result, variables) => {
      invalidatePeriod(variables.periodId);
      invalidateReviews(variables.periodId);
    },
  });

  const approveMutation = useMutation({
    mutationFn: (variables: { periodId: string; approved: boolean }) =>
      setAttendanceApproved(client, variables.periodId, variables.approved),
    onSuccess: (_result, variables) => invalidatePeriod(variables.periodId),
  });

  const publishMutation = useMutation({
    mutationFn: (id: string) => publishForPeriod(id),
    onSuccess: (_count, id) => invalidatePublishedCount(id),
  });

  const lockMutation = useMutation({
    mutationFn: async (id: string) => {
      await lockPeriod(client, id);
      // Publishing is the second half of the lock. The lock already stands even
      // when publishing fails, so the publish error is surfaced to the caller
      // and the UI still refreshes into the locked state.
      try {
        await publishForPeriod(id);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Vui lòng thử lại.";
        const publishError = new Error(`${detail} Bấm "Phát hành phiếu lương" để thử lại.`);
        publishError.name = "PayslipPublishError";
        throw publishError;
      }
    },
    onSuccess: (_result, id) => {
      invalidatePeriod(id);
      invalidatePeriods();
      invalidatePublishedCount(id);
    },
    onError: (_error, id) => {
      invalidatePeriod(id);
      invalidatePeriods();
    },
  });

  const createMutation = useMutation({
    mutationFn: (input: BepBnPeriodInput) => createPeriod(client, input),
    onSuccess: () => invalidatePeriods(),
  });

  const employeeMutation = useMutation({
    mutationFn: (variables: { periodId: string; employee: PayrollEmployee }) =>
      upsertEmployee(client, variables.periodId, variables.employee),
    onSuccess: (_result, variables) => invalidatePeriod(variables.periodId),
  });

  const upsertContactMutation = useMutation({
    mutationFn: (input: { employeeCode: string; phone: string; active: boolean }) =>
      upsertEmployeeContact(client, input),
    onSuccess: () => invalidateContacts(),
  });

  const deleteContactMutation = useMutation({
    mutationFn: (employeeCode: string) => deleteEmployeeContact(client, employeeCode),
    onSuccess: () => invalidateContacts(),
  });

  return {
    periods: periodsQuery.data ?? [],
    periodsLoading: periodsQuery.isLoading,
    periodsError: periodsQuery.error ? errorMessage(periodsQuery.error) : null,
    // measures is always {}: manual figures are recorded as adjustments.
    data: periodId ? ((dataQuery.data ?? null) as BepBnPeriodData | null) : null,
    dataLoading: Boolean(periodId) && dataQuery.isLoading,
    dataError: dataQuery.error ? errorMessage(dataQuery.error) : null,
    previousEmployees: previousEmployeesQuery.data ?? [],
    issueReviews: issueReviewsQuery.data ?? [],
    attendanceApprovedAt: dataQuery.data?.attendanceApprovedAt ?? null,
    importAttendance: (input) => importMutation.mutateAsync(input),
    importFile: (input) => importFileMutation.mutateAsync(input),
    addAdjustment: (id, input) => adjustmentMutation.mutateAsync({ periodId: id, input }),
    reviewIssue: (id, input) => reviewMutation.mutateAsync({ periodId: id, input }),
    setAttendanceApproved: (id, approved) => approveMutation.mutateAsync({ periodId: id, approved }),
    lockPeriod: (id) => lockMutation.mutateAsync(id),
    createPeriod: (input) => createMutation.mutateAsync(input),
    upsertEmployee: (id, employee) =>
      employeeMutation.mutateAsync({ periodId: id, employee }),
    contacts: contactsQuery.data ?? [],
    upsertContact: (input) => upsertContactMutation.mutateAsync(input),
    deleteContact: (employeeCode) => deleteContactMutation.mutateAsync(employeeCode),
    publishPayslips: (id) => publishMutation.mutateAsync(id),
    publishedCount: publishedCountQuery.data ?? 0,
  };
};

export default useBepBnData;
