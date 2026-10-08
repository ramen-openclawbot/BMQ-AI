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
  importAttendance,
  listPeriods,
  loadPeriodData,
  lockPeriod,
  upsertEmployee,
} from "@/lib/payroll-bn/db-client.ts";
import type { BepBnClient } from "@/lib/payroll-bn/db-client.ts";
import type {
  BepBnAdjustmentInput,
  BepBnDataSource,
  BepBnPeriodData,
  BepBnPeriodInput,
  UseBepBnData,
} from "@/components/payroll/bep-bn/types";
import type { AttendanceRow, PayrollEmployee } from "@/lib/payroll-bn/types.ts";

const PERIODS_QUERY_KEY = ["payroll-bn", "periods"] as const;
const periodQueryKey = (periodId: string) => ["payroll-bn", "period", periodId] as const;

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

  const invalidatePeriod = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ["payroll-bn", "period", id] });
  };
  const invalidatePeriods = () => {
    void queryClient.invalidateQueries({ queryKey: ["payroll-bn", "periods"] });
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

  const adjustmentMutation = useMutation({
    mutationFn: (variables: { periodId: string; input: BepBnAdjustmentInput }) =>
      addAdjustment(client, variables.periodId, variables.input),
    onSuccess: (_result, variables) => invalidatePeriod(variables.periodId),
  });

  const lockMutation = useMutation({
    mutationFn: (id: string) => lockPeriod(client, id),
    onSuccess: (_result, id) => {
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

  return {
    periods: periodsQuery.data ?? [],
    periodsLoading: periodsQuery.isLoading,
    periodsError: periodsQuery.error ? errorMessage(periodsQuery.error) : null,
    // measures is always {}: manual figures are recorded as adjustments.
    data: periodId ? ((dataQuery.data ?? null) as BepBnPeriodData | null) : null,
    dataLoading: Boolean(periodId) && dataQuery.isLoading,
    dataError: dataQuery.error ? errorMessage(dataQuery.error) : null,
    importAttendance: (input) => importMutation.mutateAsync(input),
    addAdjustment: (id, input) => adjustmentMutation.mutateAsync({ periodId: id, input }),
    lockPeriod: (id) => lockMutation.mutateAsync(id),
    createPeriod: (input) => createMutation.mutateAsync(input),
    upsertEmployee: (id, employee) =>
      employeeMutation.mutateAsync({ periodId: id, employee }),
  };
};

export default useBepBnData;
