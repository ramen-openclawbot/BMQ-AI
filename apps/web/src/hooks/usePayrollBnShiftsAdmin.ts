/**
 * Data-only hook for weekly Bếp bánh shift registration (payroll_bn).
 *
 * No JSX and no layout: the Maestro builds the screens. Every write goes
 * through the SECURITY DEFINER shift RPCs (owner or payroll.edit is enforced
 * inside the database), never through direct table writes. Query caches are
 * invalidated only after a successful RPC.
 */

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

interface DbErrorLike {
  message?: string;
  code?: string | null;
}

interface RpcResult {
  data: unknown;
  error: DbErrorLike | null;
}

export interface PayrollBnShiftsAdminClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

const client = supabase as unknown as PayrollBnShiftsAdminClient;

export interface PayrollBnShiftSettings {
  id: boolean;
  eligible_groups: string[];
  open_iso_dow: number;
  deadline_iso_dow: number;
  deadline_time: string;
  max_off_per_day: number;
  min_staff_per_day: number;
  min_off_days_per_week: number;
}

export interface PayrollBnShiftType {
  code: string;
  label: string | null;
  start_time: string;
  end_time: string | null;
  sort: number;
  active: boolean;
}

export interface PayrollBnShiftQuota {
  shift_code: string;
  iso_dow: number | null;
  needed: number;
  quota_group: string | null;
}

export interface PayrollBnShiftWeekRow {
  week_start: string;
  status: "open" | "published";
  closed_dates: string[];
  published_at: string | null;
  published_by: string | null;
}

export interface PayrollBnShiftEntry {
  work_date: string;
  shift_code: string | null;
  state: "registered" | "waitlist";
  source: "employee" | "manager" | "carried";
  previous_shift_code: string | null;
}

export interface PayrollBnShiftSuggestion {
  work_date: string;
  shift_code: string | null;
  state: "registered" | "waitlist";
  carried: true;
}

export interface PayrollBnShiftEmployee {
  employee_code: string;
  employee_name: string;
  employment_type: string;
  group_name: string | null;
  has_entries: boolean;
  entries: PayrollBnShiftEntry[];
  suggestions: PayrollBnShiftSuggestion[];
}

export interface PayrollBnShiftCoverageShift {
  code: string;
  registered: number;
  needed: number;
  quota_group: string | null;
  full: boolean;
  need_more: boolean;
}

export interface PayrollBnShiftCoverageGroup {
  quota_group: string;
  registered: number;
  needed: number;
  full: boolean;
}

export interface PayrollBnShiftCoverageDay {
  work_date: string;
  shifts: PayrollBnShiftCoverageShift[];
  quota_groups: PayrollBnShiftCoverageGroup[];
  off_count: number;
  total_staff: number;
}

export interface PayrollBnShiftCoverage {
  week_start: string;
  dates: PayrollBnShiftCoverageDay[];
  settings: { max_off_per_day: number; min_staff_per_day: number };
}

export interface PayrollBnShiftWarnings {
  below_needed: Array<{
    work_date: string;
    code: string;
    registered: number;
    needed: number;
  }>;
  below_min_staff: Array<{
    work_date: string;
    total_staff: number;
    min_staff_per_day: number;
  }>;
  off_above_max: Array<{
    work_date: string;
    off_count: number;
    max_off_per_day: number;
  }>;
  unregistered: string[];
}

export interface PayrollBnShiftBoard {
  week_start: string;
  settings: PayrollBnShiftSettings;
  shift_types: PayrollBnShiftType[];
  quotas: PayrollBnShiftQuota[];
  week: PayrollBnShiftWeekRow | null;
  coverage: PayrollBnShiftCoverage;
  employees: PayrollBnShiftEmployee[];
  totals: {
    employees: number;
    entries: number;
    registered: number;
    waitlist: number;
    off_days: number;
    unregistered: number;
  };
  warnings: PayrollBnShiftWarnings;
}

export interface PayrollBnShiftConfigInput {
  shift_types?: Array<{
    code: string;
    label?: string | null;
    start_time: string;
    end_time?: string | null;
    sort?: number;
    active?: boolean;
  }>;
  quotas?: Array<{
    shift_code: string;
    iso_dow?: number | null;
    needed: number;
    quota_group?: string | null;
  }>;
  settings?: Partial<Omit<PayrollBnShiftSettings, "id">>;
}

export interface PayrollBnShiftsAdminOptions {
  weekStart?: string | null;
  enabled?: boolean;
}

const GENERIC_ERROR = "Không thực hiện được thao tác lịch ca. Vui lòng thử lại.";

export function formatPayrollBnShiftsAdminError(error: unknown): string {
  const message = (error as DbErrorLike | null)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : GENERIC_ERROR;
}

async function callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(formatPayrollBnShiftsAdminError(error));
  return data;
}

export function usePayrollBnShiftsAdmin(options: PayrollBnShiftsAdminOptions = {}) {
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const weekStart = options.weekStart ?? null;

  const boardQuery = useQuery({
    queryKey: ["payroll-bn-shifts", weekStart],
    enabled,
    queryFn: async (): Promise<PayrollBnShiftBoard | null> => {
      const data = await callRpc("get_payroll_bn_shift_board", {
        p_week_start: weekStart,
      });
      return data && typeof data === "object" ? (data as PayrollBnShiftBoard) : null;
    },
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["payroll-bn-shifts"] });
  }, [queryClient]);

  const setEntryMutation = useMutation({
    mutationFn: async (input: {
      weekStart?: string | null;
      employeeCode: string;
      workDate: string;
      shiftCode: string | null;
    }) =>
      callRpc("set_payroll_bn_shift_entry", {
        p_week_start: input.weekStart ?? weekStart,
        p_employee_code: input.employeeCode,
        p_work_date: input.workDate,
        p_shift_code: input.shiftCode ?? null,
      }),
    onSuccess: invalidate,
  });

  const publishMutation = useMutation({
    mutationFn: async (input?: { weekStart?: string | null }) =>
      callRpc("publish_payroll_bn_shift_week", {
        p_week_start: input?.weekStart ?? weekStart,
      }),
    onSuccess: invalidate,
  });

  const reopenMutation = useMutation({
    mutationFn: async (input?: { weekStart?: string | null }) =>
      callRpc("reopen_payroll_bn_shift_week", {
        p_week_start: input?.weekStart ?? weekStart,
      }),
    onSuccess: invalidate,
  });

  const setClosedDatesMutation = useMutation({
    mutationFn: async (input: {
      weekStart?: string | null;
      dates: string[];
    }) =>
      callRpc("set_payroll_bn_shift_closed_dates", {
        p_week_start: input.weekStart ?? weekStart,
        p_dates: input.dates,
      }),
    onSuccess: invalidate,
  });

  const upsertConfigMutation = useMutation({
    mutationFn: async (input: { config: PayrollBnShiftConfigInput }) =>
      callRpc("upsert_payroll_bn_shift_config", {
        p: input.config,
      }),
    onSuccess: invalidate,
  });

  return {
    weekStart,
    boardQuery,
    board: boardQuery.data ?? null,
    employees: boardQuery.data?.employees ?? [],
    coverage: boardQuery.data?.coverage ?? null,
    warnings: boardQuery.data?.warnings ?? null,
    setEntry: setEntryMutation,
    publish: publishMutation,
    reopen: reopenMutation,
    setClosedDates: setClosedDatesMutation,
    upsertConfig: upsertConfigMutation,
  };
}

export default usePayrollBnShiftsAdmin;
